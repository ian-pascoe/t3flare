// The sealed credentials store (SPI-1162): a value is kept under AES-GCM with the stage's credentials key, bound to its
// name, write-only to everything but `open`; a missing key refuses to store, and a wrong key or a moved record reads as
// nothing.
import { describe, expect, it } from "vitest";

import { CredentialsKeyMissing, sealedStore } from "../src/credentials/sealed.ts";

const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

describe("sealedStore", () => {
  it("opens what it sealed, and keeps no plaintext", async () => {
    const kv = memory();
    const sealed = sealedStore(kv, KEY, () => 1_000);
    await sealed.put("endpoint/openai/api-key", "sk-secret-value-123");
    expect(await sealed.open("endpoint/openai/api-key")).toBe("sk-secret-value-123");
    expect(JSON.stringify([...kv.map.entries()])).not.toContain("sk-secret-value-123");
  });

  it("marks a value as set, when, and with a fingerprint that follows the value", async () => {
    const sealed = sealedStore(memory(), KEY, () => 1_000);
    expect(sealed.mark("x")).toEqual({ set: false, setAt: null, fingerprint: null });
    const first = await sealed.put("x", "one");
    expect(first).toMatchObject({ set: true, setAt: 1_000 });
    expect(first.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect((await sealed.put("y", "one")).fingerprint).toBe(first.fingerprint);
    expect((await sealed.put("x", "two")).fingerprint).not.toBe(first.fingerprint);
    expect(sealed.mark("x").set).toBe(true);
  });

  it("refuses to store without a credentials key, or with a short one", async () => {
    for (const key of [undefined, "", "short"]) {
      const kv = memory();
      const sealed = sealedStore(kv, key);
      expect(sealed.available).toBe(false);
      await expect(sealed.put("x", "value")).rejects.toBeInstanceOf(CredentialsKeyMissing);
      expect(kv.map.size).toBe(0);
    }
  });

  it("reads nothing under another key, or from a record moved to another name", async () => {
    const kv = memory();
    await sealedStore(kv, KEY).put("a", "value");
    expect(await sealedStore(kv, OTHER).open("a")).toBeUndefined();
    expect(await sealedStore(kv, undefined).open("a")).toBeUndefined();
    const [[stored, record]] = [...kv.map.entries()].filter(([name]) => name.endsWith("/a"));
    kv.map.set(stored.replace(/\/a$/, "/b"), record);
    expect(await sealedStore(kv, KEY).open("b")).toBeUndefined();
  });

  it("removes a value", async () => {
    const sealed = sealedStore(memory(), KEY);
    await sealed.put("a", "value");
    sealed.remove("a");
    expect(await sealed.open("a")).toBeUndefined();
    expect(sealed.mark("a").set).toBe(false);
  });
});
