// The one canonical JSON helper (src/mcp/canonical.ts), SPI-1195 review: the Settings server's form drops undefined
// keys, and the MCP host's definitionHash keeps them, byte-identical to the hashes stored with kept inventories before
// the helper was shared (a changed hash would ask the owner again about every tool).
import { sha256Hex } from "@t3flare/skills";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/mcp/canonical.ts";
import { definitionHash } from "../src/mcp/host.ts";

/** mcp/host.ts's own `canonical` as it was before the helper was shared: the reference for stored hashes. */
const before = (value: unknown): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(before).join(",")}]`
      : `{${Object.keys(value as object)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${before((value as Record<string, unknown>)[key])}`)
          .join(",")}}`;

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined keys", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: undefined }], c: null }, e: undefined })).toBe('{"a":{"c":null,"d":[{"z":1}]},"b":1}');
  });

  it("keeps undefined keys for definitionHash, byte-identical to the hashes kept before", async () => {
    const definitions = [
      { name: "search", description: "Search", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
      { name: "write", title: "Write", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: undefined } },
      { name: "bare" },
    ];
    for (const definition of definitions) {
      const { name, title, description, inputSchema, outputSchema, annotations } = definition as Record<string, unknown>;
      const fields = { name, title, description, inputSchema, outputSchema, annotations };
      expect(canonicalJson(fields, true)).toBe(before(fields));
      expect(await definitionHash(definition)).toBe((await sha256Hex(before(fields))).slice(0, 32));
    }
  });
});
