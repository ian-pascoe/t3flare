// A Session's sign-out decision (SPI-1164): whether its turns run on the signed-out endpoint is kept in its own storage
// at each turn's start, so a Session restarted since (a new object over the same storage) still stops them.
import { describe, expect, it } from "vitest";

import { noteTurnProvider, runsOn } from "../src/session/signOut.ts";

const storage = () => {
  const map = new Map<string, unknown>();
  return { get: <T>(key: string) => map.get(key) as T | undefined, put: <T>(key: string, value: T) => void map.set(key, value) };
};

describe("a Session's turns on a signed-out endpoint", () => {
  it("knows its turns' endpoint from its storage, after a restart too", () => {
    const kv = storage();
    expect(runsOn(kv, "chatgpt")).toBe(false);
    noteTurnProvider(kv, "chatgpt");
    // A restart: nothing in memory, the same storage.
    const restarted = { get: kv.get, put: kv.put };
    expect(runsOn(restarted, "chatgpt")).toBe(true);
    expect(runsOn(restarted, "openai")).toBe(false);
    noteTurnProvider(kv, "anthropic");
    expect(runsOn(restarted, "chatgpt")).toBe(false);
  });
});
