// Canonical JSON: object keys sorted at every depth, so equal values hash equally. One helper for the MCP host's tool
// definition hash and the Settings server's change hash and call digest.

/**
 * `value` as canonical JSON. A key whose value is `undefined` is dropped, as `JSON.stringify` drops it, unless
 * `keepUndefined`: then it is written `"key":undefined` (not JSON). Only the MCP host's `definitionHash` keeps them,
 * because the hashes it stored with every kept inventory were made that way, and a changed hash would ask the owner
 * again about every tool.
 */
export const canonicalJson = (value: unknown, keepUndefined = false): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map((item) => canonicalJson(item, keepUndefined)).join(",")}]`
      : `{${Object.keys(value as object)
          .sort()
          .filter((key) => keepUndefined || (value as Record<string, unknown>)[key] !== undefined)
          .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], keepUndefined)}`)
          .join(",")}}`;
