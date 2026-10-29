import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AuthChallenge,
  type ChallengeFields,
  createAuthAuthority,
  createAuthClient,
  importPairingKey,
  proofBytes,
} from "../../src/auth/index.js";

const SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const RESOURCE = "/bridge/xero";
const b64url = (b: Buffer) => b.toString("base64url");

async function handshake(
  o: { now?: () => number; tamper?: (c: AuthChallenge) => AuthChallenge } = {},
) {
  const key = await importPairingKey(SECRET);
  const authority = createAuthAuthority({ key, ...(o.now ? { now: o.now } : {}) });
  const client = createAuthClient({
    key,
    role: "endpoint",
    resource: RESOURCE,
    ...(o.now ? { now: o.now } : {}),
  });
  const issued = await authority.challenge(JSON.stringify(client.hello()), {
    role: "endpoint",
    resource: RESOURCE,
  });
  if (!issued.ok) throw new Error(issued.error);
  const challenge = o.tamper ? o.tamper(issued.value.frame) : issued.value.frame;
  return { key, authority, client, challenge, pending: issued.value.pending };
}

describe("pairing key", () => {
  it("derives keyId as base64url(SHA-256(secret bytes))[0..22]", async () => {
    const key = await importPairingKey(SECRET);
    expect(key.keyId).toBe(
      b64url(createHash("sha256").update(Buffer.from(SECRET, "hex")).digest()).slice(0, 22),
    );
  });

  it("refuses a secret that isn't 64 lowercase hex", async () => {
    await expect(importPairingKey("short")).rejects.toThrow();
    await expect(importPairingKey(SECRET.toUpperCase())).rejects.toThrow();
  });
});

describe("proofs — golden vector against an independent HMAC", () => {
  const fields: ChallengeFields = {
    keyId: "kid",
    instanceId: "inst",
    sessionId: "sess",
    clientNonce: "cn",
    serverNonce: "sn",
    issuedAtMs: 1000,
    expiresAtMs: 11000,
    role: "endpoint",
    resource: RESOURCE,
  };

  it("canonical bytes are a fixed JSON array", () => {
    expect(new TextDecoder().decode(proofBytes("server", fields))).toBe(
      '["mcp-bridge.auth",1,"server","kid","inst","sess","cn","sn",1000,11000,"endpoint","/bridge/xero"]',
    );
    expect(
      new TextDecoder()
        .decode(proofBytes("accept", fields, "cp"))
        .endsWith(',"/bridge/xero","cp"]'),
    ).toBe(true);
  });

  it("WebCrypto signatures equal node:crypto HMAC-SHA256 over the same bytes", async () => {
    const key = await importPairingKey(SECRET);
    const ours = Buffer.from(await key.sign(proofBytes("client", fields)));
    const theirs = createHmac("sha256", Buffer.from(SECRET, "hex"))
      .update(proofBytes("client", fields))
      .digest();
    expect(ours.equals(theirs)).toBe(true);
  });
});

describe("handshake", () => {
  it("authenticates both ways", async () => {
    const { authority, client, challenge, pending } = await handshake();
    const response = await client.answer(JSON.stringify(challenge));
    const accepted = await authority.accept(JSON.stringify(response), pending);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) await client.confirm(JSON.stringify(accepted.value));
    expect(client.state).toBe("authenticated");
  });

  it("refuses a relay that doesn't hold the secret (server proof checked first)", async () => {
    const { client, challenge } = await handshake();
    const forged = { ...challenge, serverProof: b64url(Buffer.alloc(32, 7)) };
    await expect(client.answer(JSON.stringify(forged))).rejects.toThrow(/does not hold the secret/);
    expect(client.state).toBe("failed");
  });

  it.each([
    ["role", (c: AuthChallenge) => ({ ...c, role: "client" as const })],
    ["resource", (c: AuthChallenge) => ({ ...c, resource: "/bridge/other" })],
    ["clientNonce", (c: AuthChallenge) => ({ ...c, clientNonce: b64url(Buffer.alloc(32, 1)) })],
    ["sessionId", (c: AuthChallenge) => ({ ...c, sessionId: b64url(Buffer.alloc(16, 2)) })],
    ["expiresAtMs", (c: AuthChallenge) => ({ ...c, expiresAtMs: c.expiresAtMs - 1 })],
  ])("rejects a challenge with a changed %s", async (_field, tamper) => {
    const { client, challenge } = await handshake({ tamper });
    await expect(client.answer(JSON.stringify(challenge))).rejects.toThrow();
  });

  it("rejects extra keys and duplicate keys in a challenge", async () => {
    const { client, challenge } = await handshake();
    await expect(client.answer(JSON.stringify({ ...challenge, extra: 1 }))).rejects.toThrow(
      /malformed/,
    );
    const fresh = await handshake();
    const dup = JSON.stringify(fresh.challenge).replace('"v":1', '"v":1,"v":1');
    await expect(fresh.client.answer(dup)).rejects.toThrow(/malformed/);
  });

  it("rejects an expired challenge and a relay clock far off", async () => {
    let t = 1_000_000;
    const late = await handshake({ now: () => t });
    t += 11_000;
    await expect(late.client.answer(JSON.stringify(late.challenge))).rejects.toThrow(
      /expired|lifetime/,
    );
  });

  it("makes each challenge single-use and refuses a replayed hello", async () => {
    const { key, authority, client, challenge, pending } = await handshake();
    const response = JSON.stringify(await client.answer(JSON.stringify(challenge)));
    expect((await authority.accept(response, pending)).ok).toBe(true);
    expect(await authority.accept(response, pending)).toEqual({ ok: false, error: "replay" });

    const again = createAuthClient({
      key,
      role: "endpoint",
      resource: RESOURCE,
      clientNonce: challenge.clientNonce,
    });
    const replay = await authority.challenge(JSON.stringify(again.hello()), {
      role: "endpoint",
      resource: RESOURCE,
    });
    expect(replay).toEqual({ ok: false, error: "replay" });
  });

  it("refuses a wrong client proof", async () => {
    const { authority, challenge, pending } = await handshake();
    const bad = {
      type: "auth.response",
      v: 1,
      sessionId: challenge.sessionId,
      clientProof: b64url(Buffer.alloc(32, 9)),
    };
    expect(await authority.accept(JSON.stringify(bad), pending)).toEqual({
      ok: false,
      error: "bad_proof",
    });
  });
});
