// The Credential broker with a Claude sign-in (SPI-1165): the same broker and lock as ChatGPT's (SPI-1164), with
// Anthropic's vendor. Its tokens last 8 h and its refresh token rotates on every refresh, a replaced one refused, so a
// lost rotation costs a sign-in (SPI-1161 Q5): one refresh however many ask, saved before use. Anthropic offers no
// revocation: sign-out removes the tokens here and sends nothing. Every test ends with a scan of the storage and the
// console for everything secret the fake made or saw, a waiting attempt's state and verifier included.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CredentialBroker, credentialBroker } from "../src/credentials/broker.ts";
import { claudeSignIn } from "../src/credentials/claude.ts";
import { sealedStore } from "../src/credentials/sealed.ts";
import { type FakeAnthropic, fakeAnthropic } from "./fixtures/fakeAnthropicAuth.ts";

const HOURS_8 = 8 * 3_600_000;

const memory = () => {
  const map = new Map<string, unknown>();
  let failPut: ((key: string) => boolean) | undefined;
  return {
    map,
    failWhen: (test: ((key: string) => boolean) | undefined) => void (failPut = test),
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => {
      if (failPut?.(key) === true) throw new Error("storage write failed");
      map.set(key, structuredClone(value));
    },
    delete: (key: string) => map.delete(key),
  };
};

let logged: Array<string> = [];
beforeEach(() => {
  logged = [];
  for (const level of ["log", "warn", "error", "info"] as const) vi.spyOn(console, level).mockImplementation((...args: Array<unknown>) => void logged.push(args.map(String).join(" ")));
});
afterEach(() => vi.restoreAllMocks());

const setup = () => {
  let clock = 1_000_000;
  const now = () => clock;
  const vendor = fakeAnthropic();
  const kv = memory();
  const broker = credentialBroker({ kv, sealed: sealedStore(kv, "c".repeat(64), now), vendors: { claude: claudeSignIn({ fetch: vendor.fetch, now }) }, now });
  return { kv, vendor, broker, advance: (ms: number) => void (clock += ms), now };
};

const signIn = async (broker: CredentialBroker, vendor: FakeAnthropic, account: { readonly uuid?: string; readonly email?: string } = { uuid: "acct-7", email: "owner@example.com" }) => {
  const { authorizeUrl } = await broker.start("claude", "claude");
  return broker.complete("claude", vendor.approve(authorizeUrl, account));
};

const scan = (kv: ReturnType<typeof memory>, vendor: FakeAnthropic) => {
  const stored = JSON.stringify([...kv.map.entries()]);
  const output = logged.join("\n");
  for (const secret of vendor.secrets()) {
    expect(stored).not.toContain(secret);
    expect(output).not.toContain(secret);
  }
};

describe("the Credential broker with a Claude sign-in", () => {
  it("signs in from the pasted code, seals the tokens, and gives the access token with its expiry", async () => {
    const { kv, vendor, broker, now } = setup();
    expect(await signIn(broker, vendor)).toMatchObject({ ok: true });
    expect(broker.status("claude")).toMatchObject({ kind: "claude", signedIn: true, email: "owner@example.com", subject: "acct-7", clientId: null, expiresAt: now() + HOURS_8 });
    expect(await broker.access("claude")).toEqual({ ok: true, accessToken: vendor.accessTokens[0], expiresAt: now() + HOURS_8 });
    scan(kv, vendor);
  });

  it("keeps a waiting attempt sealed: its state, challenge and verifier, and the code pasted, are nowhere in the storage", async () => {
    const { kv, vendor, broker } = setup();
    const { authorizeUrl } = await broker.start("claude", "claude");
    vendor.options.tokenDown = true;
    expect(await broker.complete("claude", vendor.approve(authorizeUrl))).toMatchObject({ ok: false, problem: expect.stringMatching(/could not be reached/) });
    expect(broker.status("claude").pendingSince).not.toBeNull();
    // The fake saw the state and challenge (the authorize URL) and the code, state and verifier (the exchange).
    expect(vendor.secrets().length).toBeGreaterThanOrEqual(5);
    scan(kv, vendor);
    vendor.options.tokenDown = false;
  });

  it("signs the endpoint out when the grant was removed at claude.ai (a 401 with no OAuth code), instead of failing every turn as retryable", async () => {
    const { kv, vendor, broker, advance } = setup();
    await signIn(broker, vendor);
    advance(HOURS_8);
    vendor.options.refreshStatus = 401;
    vendor.options.refreshBody = { type: "error", error: { type: "authentication_error", message: "invalid" } };
    expect(await broker.access("claude")).toMatchObject({ ok: false, signedOut: true, problem: "Claude refused to renew the sign-in (HTTP 401): it is signed out" });
    expect(await broker.access("claude")).toMatchObject({ ok: false, signedOut: true });
    expect(vendor.counts.refreshes).toBe(1);
    scan(kv, vendor);
  });

  it("shows a passing renewal failure on the panel's status until a renewal succeeds", async () => {
    const { kv, vendor, broker, advance } = setup();
    await signIn(broker, vendor);
    advance(HOURS_8 - 60_000);
    vendor.options.refreshStatus = 503;
    expect(await broker.access("claude")).toMatchObject({ ok: true });
    expect(broker.status("claude")).toMatchObject({ signedIn: true, problem: "Anthropic did not renew the Claude sign-in (HTTP 503): it is tried again at the next use", problemAt: expect.any(Number) });
    vendor.options.refreshStatus = undefined;
    expect(await broker.access("claude")).toMatchObject({ ok: true, accessToken: vendor.accessTokens[1] });
    expect(broker.status("claude")).toMatchObject({ signedIn: true, problem: null, problemAt: null });
    scan(kv, vendor);
  });

  it("signs out by removing the tokens and stopping the Sessions, sending nothing to Anthropic, which offers no revocation", async () => {
    const { kv, vendor, broker } = setup();
    await signIn(broker, vendor);
    const before = vendor.requests.length;
    const order: Array<string> = [];
    const out = await broker.signOut("claude", {
      beforeRevoke: async () => void order.push(`removed: ${(await broker.read("claude")) === undefined}`),
    });
    expect(out).toEqual({ signedOut: true, revoked: false });
    expect(order).toEqual(["removed: true"]);
    expect(vendor.requests).toHaveLength(before);
    // No registration to keep for Claude: the account is forgotten whole, its email included.
    expect(broker.status("claude")).toMatchObject({ signedIn: false, subject: null, email: null, expiresAt: null });
    expect(await broker.access("claude")).toMatchObject({ ok: false, signedOut: true });
    // Another account may sign in next.
    expect(await signIn(broker, vendor, { uuid: "acct-9", email: "other@example.com" })).toMatchObject({ ok: true });
    expect(broker.status("claude")).toMatchObject({ signedIn: true, email: "other@example.com" });
    scan(kv, vendor);
  });

  // SPI-1171: the leak check looks for a sign-in's tokens in the Container, as stored, without renewing them.
  it("gives its tokens as stored for the leak check, renewing nothing, and none once signed out", async () => {
    const { vendor, broker, advance } = setup();
    await signIn(broker, vendor);
    advance(HOURS_8 - 60_000);
    const secrets = await broker.secrets("claude");
    expect(secrets.map((entry) => entry.name)).toEqual(["sign-in:claude:access", "sign-in:claude:refresh"]);
    expect(secrets[0]!.value).toBe(vendor.accessTokens[0]);
    expect(vendor.secrets()).toContain(secrets[1]!.value);
    expect(vendor.counts.refreshes).toBe(0);
    await broker.signOut("claude");
    expect(await broker.secrets("claude")).toEqual([]);
  });

  // SPI-1171: a stage's hook (`POST /_t3flare/check/sign-in-expire`) proves a mid-thread refresh without waiting 8 h.
  it("renews at the next use a token marked expired, as at its real expiry", async () => {
    const { vendor, broker } = setup();
    await signIn(broker, vendor);
    expect(await broker.expire("claude")).toBe(true);
    expect(await broker.access("claude")).toMatchObject({ ok: true, accessToken: vendor.accessTokens[1] });
    expect(vendor.counts.refreshes).toBe(1);
    expect(await broker.access("claude")).toMatchObject({ ok: true, accessToken: vendor.accessTokens[1] });
    expect(vendor.counts.refreshes).toBe(1);
    await broker.signOut("claude");
    expect(await broker.expire("claude")).toBe(false);
  });
});
