// The Model endpoints' keys the Workspace DO looks for (SPI-1167): the relay's keys by hash for the sync guard, one per
// endpoint and capped; the leak check's by value in the DO and by hash in the Container; a short key is never scanned for
// in the Container (its unsalted hash would go into the scanner's argv).
import { patternOf } from "@t3flare/sandbox-image/leakscan";
import { describe, expect, it } from "vitest";

import { EndpointKeyPatterns, leakTargets, MAX_ENDPOINT_KEYS, MIN_SCANNED_KEY_LENGTH, MIN_SEARCHED_VALUE_LENGTH } from "../src/workspace/endpointKeys.ts";

const LONG = "sk-endpoint-key-0123456789abcdef";

describe("the relay's endpoint keys for the sync guard", () => {
  it("keeps each endpoint's newest key by its pattern, never its value", async () => {
    const keys = new EndpointKeyPatterns();
    await keys.remember("openai", LONG);
    await keys.remember("openai", LONG);
    expect(keys.values()).toEqual([await patternOf("endpoint:openai", LONG)]);
    await keys.remember("openai", `${LONG}-2`);
    expect(keys.values()).toEqual([await patternOf("endpoint:openai", `${LONG}-2`)]);
    expect(JSON.stringify(keys.values())).not.toContain(LONG);
  });

  it("scans for no short key, and keeps at most MAX_ENDPOINT_KEYS endpoints, the oldest going first", async () => {
    const keys = new EndpointKeyPatterns();
    await keys.remember("short", "x".repeat(MIN_SCANNED_KEY_LENGTH - 1));
    expect(keys.values()).toEqual([]);
    for (let n = 0; n <= MAX_ENDPOINT_KEYS; n++) await keys.remember(`e${n}`, `${LONG}-${n}`);
    expect(keys.values()).toHaveLength(MAX_ENDPOINT_KEYS);
    expect(keys.values().map((pattern) => pattern.name)).not.toContain("endpoint:e0");
  });
});

describe("the leak check's endpoint keys", () => {
  it("are looked for by value in the DO's files, and by hash in the Container only when long enough", async () => {
    const targets = await leakTargets([
      { name: "endpoint:openai", value: LONG },
      { name: "endpoint:short", value: "short-key-123" },
      { name: "endpoint:tiny", value: "x".repeat(MIN_SEARCHED_VALUE_LENGTH - 1) },
    ]);
    expect(targets.values).toEqual([
      ["endpoint:openai", LONG],
      ["endpoint:short", "short-key-123"],
    ]);
    expect(targets.patterns).toEqual([await patternOf("endpoint:openai", LONG)]);
    // A skip is named, never shown, so it does not read as a clean scan.
    expect(targets.skipped).toEqual([
      { name: "endpoint:short", where: "container" },
      { name: "endpoint:tiny", where: "everywhere" },
    ]);
    expect(JSON.stringify(targets.skipped)).not.toContain("short-key-123");
  });

  it("takes a sign-in's tokens as hashes only (SPI-1171): scanned in the Container, never a value, a malformed or short one refused", async () => {
    const token = await patternOf("sign-in:claude:access", LONG);
    const targets = await leakTargets(
      [],
      [
        token,
        { name: "sign-in:claude:refresh", prefix: "sk-a", length: MIN_SCANNED_KEY_LENGTH - 1, sha256: "a".repeat(64) },
        { name: "sign-in:x:access", prefix: "toolongprefix", length: 40, sha256: "a".repeat(64) },
        { name: "sign-in:y:access", prefix: "abcd", length: 40, sha256: "not-a-hash" },
      ],
    );
    expect(targets.values).toEqual([]);
    expect(targets.patterns).toEqual([token]);
    expect(targets.skipped).toEqual([
      { name: "sign-in:claude:refresh", where: "everywhere" },
      { name: "sign-in:x:access", where: "everywhere" },
      { name: "sign-in:y:access", where: "everywhere" },
    ]);
    // The scanned one is named as looked for in the Container only (not in the DO's files), so the gap shows.
    expect(targets.containerOnly).toEqual(["sign-in:claude:access"]);
  });
});
