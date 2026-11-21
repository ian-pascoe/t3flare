// @effect-diagnostics globalTimers:off
// The Credential broker (SPI-1164; ADR-0018 revived): the Environment DO holds each sign-in's tokens sealed, is their
// only refresher (one refresh in flight per endpoint), saves a rotated refresh token before any caller gets the new access
// token, and signs the endpoint out when OpenAI refuses a renewal. Tested against a fake of OpenAI's authorization server;
// every test ends with a scan of the storage and the console for the tokens the fake issued.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CredentialBroker, credentialBroker, signInStatusKey } from "../src/credentials/broker.ts";
import { chatgptSignIn } from "../src/credentials/chatgpt.ts";
import { sealedStore } from "../src/credentials/sealed.ts";
import { type FakeOpenAI, fakeOpenAI, gate } from "./fixtures/fakeOpenAIAuth.ts";

const KEY = "d".repeat(64);
const HOUR = 3_600_000;

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

const setup = async (options: { readonly credentialsKey?: string } = {}) => {
  let clock = 1_000_000;
  const now = () => clock;
  const vendor = await fakeOpenAI({ now });
  const kv = memory();
  const broker = credentialBroker({ kv, sealed: sealedStore(kv, options.credentialsKey ?? KEY, now), vendors: { chatgpt: chatgptSignIn({ fetch: vendor.fetch, now }) }, now });
  return { kv, vendor, broker, advance: (ms: number) => void (clock += ms), now };
};

/** Signs `id` in through the broker, as the owner does: start, approve in the browser, paste the redirect. */
const signIn = async (broker: CredentialBroker, vendor: FakeOpenAI, id = "chatgpt") => {
  const { authorizeUrl } = await broker.start(id, "chatgpt");
  return broker.complete(id, vendor.approve(authorizeUrl, { sub: "user-7", email: "owner@example.com" }));
};

/** Nothing secret the fake made or saw (tokens, codes, each attempt's state, nonce and verifier) is stored or logged. */
const scan = (kv: ReturnType<typeof memory>, vendor: FakeOpenAI) => {
  const stored = JSON.stringify([...kv.map.entries()]);
  const output = logged.join("\n");
  for (const token of vendor.secrets()) {
    expect(stored).not.toContain(token);
    expect(output).not.toContain(token);
  }
};

describe("the Credential broker", () => {
  it("signs in from a pasted redirect, seals the tokens and gives the access token with its expiry", async () => {
    const { kv, vendor, broker, now } = await setup();
    expect(await signIn(broker, vendor)).toMatchObject({ ok: true });
    expect(broker.status("chatgpt")).toMatchObject({ signedIn: true, email: "owner@example.com", expiresAt: now() + HOUR, pendingSince: null, problem: null });
    const access = await broker.access("chatgpt");
    expect(access).toEqual({ ok: true, accessToken: vendor.issued[0], expiresAt: now() + HOUR });
    expect((await broker.read("chatgpt"))?.type).toBe("oauth");
    expect(await broker.list()).toEqual([{ providerId: "chatgpt", type: "oauth" }]);
    expect(kv.map.has(signInStatusKey("chatgpt"))).toBe(true);
    scan(kv, vendor);
  });

  it("refreshes near expiry, saving the rotated refresh token, and refreshes once for concurrent callers", async () => {
    const { kv, vendor, broker, advance, now } = await setup();
    await signIn(broker, vendor);
    const first = await broker.access("chatgpt");
    // Inside the margin: five Sessions ask at once while OpenAI is slow to answer.
    advance(HOUR - 60_000);
    const slow = gate();
    vendor.options.refreshGate = slow.opened;
    vendor.options.onRefresh = slow.reached;
    const asks = Promise.all(Array.from({ length: 5 }, () => broker.access("chatgpt")));
    // The refresh holds the lock at OpenAI; whenever the others arrive, they find it renewed.
    await slow.arrived;
    slow.open();
    const answers = await asks;
    expect(vendor.counts.refreshes).toBe(1);
    const tokens = new Set(answers.map((answer) => (answer.ok ? answer.accessToken : "refused")));
    expect(tokens.size).toBe(1);
    expect(tokens.has(first.ok ? first.accessToken : "")).toBe(false);
    expect(answers[0]).toMatchObject({ ok: true, expiresAt: now() + HOUR });
    // The stored refresh token is the replacement: the next renewal uses it, and OpenAI accepts it.
    expect(await broker.read("chatgpt")).toMatchObject({ type: "oauth", refresh: vendor.currentRefresh() });
    advance(HOUR);
    expect(await broker.access("chatgpt")).toMatchObject({ ok: true });
    expect(vendor.counts.refreshes).toBe(2);
    scan(kv, vendor);
  });

  it("gives no new access token whose refresh token was not saved first", async () => {
    const { kv, vendor, broker, advance } = await setup();
    await signIn(broker, vendor);
    advance(HOUR);
    kv.failWhen((key) => key.includes("endpoint/chatgpt/oauth"));
    const answer = await broker.access("chatgpt");
    expect(answer).toMatchObject({ ok: false, signedOut: false });
    // OpenAI did renew it: a second access token exists, and it reached no caller.
    expect(vendor.counts.refreshes).toBe(1);
    expect(vendor.accessTokens).toHaveLength(2);
    expect(JSON.stringify(answer)).not.toContain(vendor.accessTokens[1]!);
    // The stored credential is still the first.
    expect(await broker.read("chatgpt")).toMatchObject({ type: "oauth", access: vendor.accessTokens[0] });
    kv.failWhen(undefined);
    scan(kv, vendor);
  });

  it("signs the endpoint out when OpenAI refuses the renewal, and says so", async () => {
    const { kv, vendor, broker, advance } = await setup();
    await signIn(broker, vendor);
    advance(HOUR);
    vendor.options.refreshError = "invalid_grant";
    const answer = await broker.access("chatgpt");
    expect(answer).toMatchObject({ ok: false, signedOut: true });
    if (!answer.ok) expect(answer.problem).toMatch(/ChatGPT refused to renew the sign-in \(invalid_grant\)/);
    expect(broker.status("chatgpt")).toMatchObject({ signedIn: false, problem: expect.stringMatching(/invalid_grant/) });
    expect(await broker.read("chatgpt")).toBeUndefined();
    // No retry loop: the next ask fails at once, without another refresh.
    expect(await broker.access("chatgpt")).toMatchObject({ ok: false, signedOut: true });
    expect(vendor.counts.refreshes).toBe(1);
    scan(kv, vendor);
  });

  it("sends one refused renewal for many concurrent callers", async () => {
    const { kv, vendor, broker, advance } = await setup();
    await signIn(broker, vendor);
    advance(HOUR);
    vendor.options.refreshError = "invalid_grant";
    const slow = gate();
    vendor.options.refreshGate = slow.opened;
    vendor.options.onRefresh = slow.reached;
    const asks = Promise.all(Array.from({ length: 5 }, () => broker.access("chatgpt")));
    await slow.arrived;
    slow.open();
    const answers = await asks;
    expect(vendor.counts.refreshes).toBe(1);
    expect(answers.every((answer) => !answer.ok && answer.signedOut)).toBe(true);
    scan(kv, vendor);
  });

  it("keeps a sign-in completed while a refused renewal was in flight: the completion waits for the lock", async () => {
    const { kv, vendor, broker, advance } = await setup();
    await signIn(broker, vendor);
    advance(HOUR);
    // The owner's new attempt is started first; then a renewal is refused while OpenAI holds it.
    const { authorizeUrl } = await broker.start("chatgpt", "chatgpt");
    vendor.options.refreshError = "invalid_grant";
    const slow = gate();
    vendor.options.refreshGate = slow.opened;
    vendor.options.onRefresh = slow.reached;
    const refused = broker.access("chatgpt");
    await slow.arrived;
    let settled = false;
    const again = broker.complete("chatgpt", vendor.approve(authorizeUrl, { sub: "user-7" })).finally(() => (settled = true));
    // However long it is given, the completion cannot finish while the refusal holds the lock (only the negative
    // direction rests on this wait).
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    slow.open();
    expect(await refused).toMatchObject({ ok: false, signedOut: true });
    expect(await again).toMatchObject({ ok: true });
    expect(await broker.read("chatgpt")).toMatchObject({ access: vendor.accessTokens.at(-1) });
    expect(broker.status("chatgpt").signedIn).toBe(true);
    scan(kv, vendor);
  });

  it("forgets the account when a renewal is refused, so another account can sign in", async () => {
    const { kv, vendor, broker, advance } = await setup();
    await signIn(broker, vendor);
    advance(HOUR);
    vendor.options.refreshError = "invalid_grant";
    await broker.access("chatgpt");
    expect(broker.status("chatgpt").subject).toBeNull();
    vendor.options.refreshError = undefined;
    const { authorizeUrl } = await broker.start("chatgpt", "chatgpt");
    expect(await broker.complete("chatgpt", vendor.approve(authorizeUrl, { sub: "user-9", email: "other@example.com" }))).toMatchObject({ ok: true });
    scan(kv, vendor);
  });

  it("starts under the lock: a start queued behind a sign-out keeps its attempt", async () => {
    const { kv, vendor, broker, advance } = await setup();
    await signIn(broker, vendor);
    advance(HOUR);
    const slow = gate();
    vendor.options.refreshGate = slow.opened;
    vendor.options.onRefresh = slow.reached;
    const refreshing = broker.access("chatgpt");
    await slow.arrived;
    // Queued in this order behind the refresh: the sign-out, then the start's write.
    const out = broker.signOut("chatgpt");
    const started = broker.start("chatgpt", "chatgpt");
    // Without the start's lock its attempt would be written now, then removed by the queued sign-out.
    await new Promise((resolve) => setTimeout(resolve, 50));
    slow.open();
    await Promise.all([refreshing, out]);
    const { authorizeUrl } = await started;
    expect(broker.status("chatgpt").pendingSince).not.toBeNull();
    expect(await broker.complete("chatgpt", vendor.approve(authorizeUrl, { sub: "user-7" }))).toMatchObject({ ok: true });
    scan(kv, vendor);
  });

  it("leaves a newer attempt waiting when an older one's code is refused", async () => {
    const { kv, vendor, broker } = await setup();
    const first = await broker.start("chatgpt", "chatgpt");
    const slow = gate();
    vendor.options.exchangeGate = slow.opened;
    vendor.options.onExchange = slow.reached;
    vendor.options.exchangeError = "invalid_grant";
    const older = broker.complete("chatgpt", vendor.approve(first.authorizeUrl));
    await slow.arrived;
    // The owner starts again while the older attempt's exchange is at OpenAI; then that exchange is refused.
    const second = await broker.start("chatgpt", "chatgpt");
    slow.open();
    expect(await older).toMatchObject({ ok: false });
    expect(broker.status("chatgpt").pendingSince).not.toBeNull();
    vendor.options.exchangeError = undefined;
    vendor.options.exchangeGate = undefined;
    expect(await broker.complete("chatgpt", vendor.approve(second.authorizeUrl))).toMatchObject({ ok: true });
    scan(kv, vendor);
  });

  it("shares one completion for a paste submitted twice", async () => {
    const { kv, vendor, broker } = await setup();
    const { authorizeUrl } = await broker.start("chatgpt", "chatgpt");
    const pasted = vendor.approve(authorizeUrl);
    const slow = gate();
    vendor.options.exchangeGate = slow.opened;
    vendor.options.onExchange = slow.reached;
    const first = broker.complete("chatgpt", pasted);
    await slow.arrived;
    const second = broker.complete("chatgpt", pasted);
    slow.open();
    const answers = await Promise.all([first, second]);
    expect(answers.every((answer) => answer.ok)).toBe(true);
    expect(vendor.counts.exchanges).toBe(1);
    expect(vendor.counts.revocations).toBe(0);
    expect(broker.status("chatgpt").signedIn).toBe(true);
    scan(kv, vendor);
  });

  it("forgets an endpoint's status in its sign-out's step: a start during the revocation keeps its own", async () => {
    const { kv, vendor, broker } = await setup();
    await signIn(broker, vendor);
    let authorizeUrl = "";
    await broker.forget("chatgpt", {
      beforeRevoke: async () => {
        authorizeUrl = (await broker.start("chatgpt", "chatgpt")).authorizeUrl;
      },
    });
    expect(broker.status("chatgpt")).toMatchObject({ kind: "chatgpt" });
    expect(broker.known()).toContain("chatgpt");
    expect(await broker.complete("chatgpt", vendor.approve(authorizeUrl))).toMatchObject({ ok: true });
    expect(broker.status("chatgpt")).toMatchObject({ kind: "chatgpt", signedIn: true });
    scan(kv, vendor);
  });

  it("keeps a token that is still valid through a passing failure, and fails once it has expired", async () => {
    const { kv, vendor, broker, advance } = await setup();
    await signIn(broker, vendor);
    vendor.options.tokenDown = true;
    advance(HOUR - 60_000);
    expect(await broker.access("chatgpt")).toMatchObject({ ok: true });
    advance(120_000);
    const answer = await broker.access("chatgpt");
    expect(answer).toMatchObject({ ok: false, signedOut: false });
    expect(broker.status("chatgpt").signedIn).toBe(true);
    scan(kv, vendor);
  });

  it("signs out by removing the tokens, then the caller's step, then revoking at OpenAI; the next sign-in reuses the client id", async () => {
    const { kv, vendor, broker } = await setup();
    await signIn(broker, vendor);
    const clientId = broker.status("chatgpt").clientId;
    const order: Array<string> = [];
    const out = await broker.signOut("chatgpt", {
      beforeRevoke: async () => {
        order.push(`removed: ${(await broker.read("chatgpt")) === undefined}, revocations: ${vendor.counts.revocations}`);
      },
    });
    expect(out).toEqual({ signedOut: true, revoked: true });
    expect(order).toEqual(["removed: true, revocations: 0"]);
    expect(vendor.counts.revocations).toBe(1);
    expect(await broker.read("chatgpt")).toBeUndefined();
    expect(broker.status("chatgpt")).toMatchObject({ signedIn: false, clientId, email: "owner@example.com" });
    expect(await broker.access("chatgpt")).toMatchObject({ ok: false, signedOut: true });
    const { authorizeUrl } = await broker.start("chatgpt", "chatgpt");
    expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe(clientId);
    scan(kv, vendor);
  });

  it("signs out after a refresh in flight, and revokes the refresh token that refresh left", async () => {
    const { kv, vendor, broker, advance } = await setup();
    await signIn(broker, vendor);
    advance(HOUR);
    const slow = gate();
    vendor.options.refreshGate = slow.opened;
    vendor.options.onRefresh = slow.reached;
    const refreshing = broker.access("chatgpt");
    // The refresh holds the lock at OpenAI: the sign-out queues behind it.
    await slow.arrived;
    const out = broker.signOut("chatgpt");
    slow.open();
    await refreshing;
    expect(await out).toEqual({ signedOut: true, revoked: true });
    // The rotated refresh token (the one OpenAI honours now) is the one revoked; nothing is left here.
    expect(vendor.revoked.has(vendor.currentRefresh()!)).toBe(true);
    expect(await broker.read("chatgpt")).toBeUndefined();
    expect(await broker.access("chatgpt")).toMatchObject({ ok: false, signedOut: true });
    scan(kv, vendor);
  });

  it("says a sign-out's revocation was not confirmed when OpenAI keeps failing it, and signs out here all the same", async () => {
    const { kv, vendor, broker } = await setup();
    await signIn(broker, vendor);
    vendor.options.revokeStatus = 503;
    expect(await broker.signOut("chatgpt")).toEqual({ signedOut: true, revoked: false });
    // Tried three times (two retries), then given up.
    expect(vendor.counts.revocations).toBe(3);
    expect(await broker.read("chatgpt")).toBeUndefined();
    scan(kv, vendor);
  });

  it("surfaces a refused exchange (a Free plan) at once, and keeps nothing of it", async () => {
    const { kv, vendor, broker } = await setup();
    vendor.options.exchangeError = "invalid_grant";
    const result = await signIn(broker, vendor);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.problem).toMatch(/Plus or Pro/);
    expect(broker.status("chatgpt")).toMatchObject({ signedIn: false, pendingSince: null, problem: expect.stringMatching(/invalid_grant/) });
    // The code is spent: a second paste finds no sign-in waiting.
    expect(await broker.complete("chatgpt", "http://127.0.0.1:1455/auth/callback?code=x&state=y")).toMatchObject({ ok: false, problem: expect.stringMatching(/No sign-in is waiting/) });
    scan(kv, vendor);
  });

  it("keeps a sign-in waiting through a mistaken paste, and lets a stale one lapse", async () => {
    const { kv, vendor, broker, advance } = await setup();
    const { authorizeUrl } = await broker.start("chatgpt", "chatgpt");
    const callback = vendor.approve(authorizeUrl);
    expect(await broker.complete("chatgpt", "not a url")).toMatchObject({ ok: false });
    expect(await broker.complete("chatgpt", callback)).toMatchObject({ ok: true });
    const again = await broker.start("chatgpt", "chatgpt");
    advance(31 * 60_000);
    expect(await broker.complete("chatgpt", vendor.approve(again.authorizeUrl))).toMatchObject({ ok: false, problem: expect.stringMatching(/lapsed/) });
    scan(kv, vendor);
  });

  it("refuses to start without a credentials key", async () => {
    const { broker } = await setup({ credentialsKey: "short" });
    await expect(broker.start("chatgpt", "chatgpt")).rejects.toThrow(/credentials key/);
  });

  it("serialises modify per endpoint, as pi-ai's CredentialStore asks", async () => {
    const { broker } = await setup();
    const order: Array<string> = [];
    const held = gate();
    const slow = broker.modify("chatgpt", async () => {
      held.reached();
      await held.opened;
      order.push("first");
      return { type: "oauth", access: "a", refresh: "r", expires: 1 };
    });
    const fast = broker.modify("chatgpt", async (current) => {
      order.push(`second saw ${current?.type === "oauth" ? current.access : "nothing"}`);
      return undefined;
    });
    // The first holds the lock until it is let go; the second, queued meanwhile, then sees what the first wrote.
    await held.arrived;
    held.open();
    await Promise.all([slow, fast]);
    expect(order).toEqual(["first", "second saw a"]);
  });

  it("lets a sign-out during a completion's exchange win: the fresh grant is revoked, nothing shows signed in", async () => {
    const { kv, vendor, broker } = await setup();
    const { authorizeUrl } = await broker.start("chatgpt", "chatgpt");
    const slow = gate();
    vendor.options.exchangeGate = slow.opened;
    vendor.options.onExchange = slow.reached;
    const completing = broker.complete("chatgpt", vendor.approve(authorizeUrl));
    await slow.arrived;
    expect(await broker.signOut("chatgpt")).toEqual({ signedOut: false, revoked: false });
    slow.open();
    expect(await completing).toMatchObject({ ok: false, problem: expect.stringMatching(/signed out or started again/) });
    expect(await broker.read("chatgpt")).toBeUndefined();
    expect(broker.status("chatgpt")).toMatchObject({ signedIn: false, pendingSince: null });
    expect(vendor.revoked.has(vendor.currentRefresh()!)).toBe(true);
    scan(kv, vendor);
  });

  it("keeps a waiting attempt sealed: its state, nonce and verifier are nowhere in the storage", async () => {
    const { kv, vendor, broker } = await setup();
    const { authorizeUrl } = await broker.start("chatgpt", "chatgpt");
    // OpenAI cannot be reached at the exchange: the attempt keeps waiting for another paste.
    vendor.options.tokenDown = true;
    expect(await broker.complete("chatgpt", vendor.approve(authorizeUrl))).toMatchObject({ ok: false });
    expect(broker.status("chatgpt").pendingSince).not.toBeNull();
    // The fake saw the attempt's state, nonce and challenge (the authorize URL) and its verifier and code (the exchange).
    expect(vendor.secrets().length).toBeGreaterThanOrEqual(5);
    scan(kv, vendor);
  });

  it("forgets the account at sign-out, so the next sign-in may be another account", async () => {
    const { kv, vendor, broker } = await setup();
    await signIn(broker, vendor);
    await broker.signOut("chatgpt");
    expect(broker.status("chatgpt").subject).toBeNull();
    const { authorizeUrl } = await broker.start("chatgpt", "chatgpt");
    expect(await broker.complete("chatgpt", vendor.approve(authorizeUrl, { sub: "user-8", email: "other@example.com" }))).toMatchObject({ ok: true });
    expect(broker.status("chatgpt")).toMatchObject({ signedIn: true, email: "other@example.com" });
    scan(kv, vendor);
  });

  it("revokes at sign-out even when stopping the Sessions failed", async () => {
    const { kv, vendor, broker } = await setup();
    await signIn(broker, vendor);
    expect(await broker.signOut("chatgpt", { beforeRevoke: () => Promise.reject(new Error("a Session broke")) })).toEqual({ signedOut: true, revoked: true });
    expect(vendor.counts.revocations).toBe(1);
    scan(kv, vendor);
  });
});

