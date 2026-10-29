import { describe, expect, it } from "vitest";
import { hasDuplicateKeys, hasExactKeys, parseStrictJsonObject } from "../../src/protocol/index.js";

describe("strict JSON", () => {
  it("accepts a plain object", () => {
    expect(parseStrictJsonObject('{"a":1,"b":{"c":[1,{"d":2}]}}', 1024)).toEqual({
      a: 1,
      b: { c: [1, { d: 2 }] },
    });
  });

  it("rejects duplicate keys at any depth, including escaped spellings", () => {
    expect(hasDuplicateKeys('{"a":1,"a":2}')).toBe(true);
    expect(hasDuplicateKeys('{"x":{"v":1,"\\u0076":2}}')).toBe(true);
    expect(hasDuplicateKeys('{"x":[{"a":1},{"a":2}]}')).toBe(false); // separate objects
    expect(hasDuplicateKeys('{"a":"a","b":"a"}')).toBe(false); // values aren't keys
    expect(parseStrictJsonObject('{"a":1,"a":2}', 1024)).toBeNull();
  });

  it("rejects oversized, invalid and non-object input", () => {
    expect(parseStrictJsonObject(`{"a":"${"x".repeat(100)}"}`, 50)).toBeNull();
    expect(parseStrictJsonObject('{"a":"é"}', 9)).toBeNull(); // 9 chars, 10 bytes
    expect(parseStrictJsonObject("{nope", 1024)).toBeNull();
    expect(parseStrictJsonObject("[1,2]", 1024)).toBeNull();
  });

  it("checks exact key sets", () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ["a", "b"])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false);
  });
});
