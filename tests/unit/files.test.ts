import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  filePayloadJsonSchema,
  fileRefJsonSchema,
  saveAsResource,
  saveFileUri,
  toClientSchema,
} from "../../src/protocol/index.js";
import { readCallFiles, saveCallFiles } from "../../src/relay/index.js";
import { nodeFiles } from "../../src/relay/node/index.js";

describe("files", () => {
  it("shows file arguments to clients as { $file }", () => {
    const schema = {
      type: "object",
      properties: { file: filePayloadJsonSchema, n: { type: "number" } },
    };
    expect(toClientSchema(schema)).toEqual({
      type: "object",
      properties: { file: fileRefJsonSchema, n: { type: "number" } },
    });
  });

  it("reads a $file argument under a root and refuses one outside it", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcpb-"));
    const path = join(root, "starters.csv");
    await writeFile(path, "a,b\n1,2\n");
    const files = nodeFiles({ roots: [root] });
    const call = (p: string) => ({
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call",
      params: { name: "import", arguments: { file: { $file: p } } },
    });

    const out = await readCallFiles(call(path), files);
    const file = (
      out.params as {
        arguments: { file: { name: string; mediaType: string; size: number; base64: string } };
      }
    ).arguments.file;
    expect(file).toMatchObject({ name: "starters.csv", mediaType: "text/csv", size: 8 });
    expect(Buffer.from(file.base64, "base64").toString()).toBe("a,b\n1,2\n");

    await expect(readCallFiles(call(join(tmpdir(), "elsewhere.csv")), files)).rejects.toThrow(
      /outside/,
    );
    await expect(readCallFiles(call("relative.csv"), files)).rejects.toThrow(/absolute/);
    await expect(readCallFiles(call(path), undefined)).rejects.toThrow(/no file access/);
  });

  it("saves returned files without overwriting, and reports where", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcpb-dl-"));
    const files = nodeFiles({ roots: [], downloadsDir: dir });
    const result = {
      content: [
        { type: "text", text: "pack ready" },
        saveAsResource("pack.zip", "application/zip", Buffer.from("zip").toString("base64")),
      ],
    };
    const first = await saveCallFiles(result, files);
    const second = await saveCallFiles(result, files);
    expect((first.content as Array<{ text: string }>)[1]?.text).toBe(
      `Saved pack.zip to ${join(dir, "pack.zip")}`,
    );
    expect((second.content as Array<{ text: string }>)[1]?.text).toBe(
      `Saved pack.zip to ${join(dir, "pack (1).zip")}`,
    );
    expect(await readFile(join(dir, "pack.zip"), "utf8")).toBe("zip");
  });

  it("saves a textual resource (JSONL, CSV) as well as a base64 blob", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcpb-dl-"));
    const files = nodeFiles({ roots: [], downloadsDir: dir });
    const out = await saveCallFiles(
      {
        content: [
          {
            type: "resource",
            resource: {
              uri: saveFileUri({ filename: "log.jsonl" }, 0),
              mimeType: "application/x-ndjson",
              text: '{"a":1}\n',
            },
          },
        ],
      },
      files,
    );
    const text = (out.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toMatch(/^Saved log\.jsonl to /);
    expect(await readFile(text.replace(/^Saved log\.jsonl to /, ""), "utf8")).toBe('{"a":1}\n');
  });
});
