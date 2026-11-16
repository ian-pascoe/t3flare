// @effect-diagnostics globalConsole:off
// The Credential broker with a GitHub Copilot sign-in (SPI-1166): the same broker and lock as ChatGPT's and Claude's,
// with GitHub's device flow. The attempt waits sealed between polls, each poll no sooner than GitHub's interval; the
// GitHub token is the sealed grant and the Copilot token is derived from it under the lock, once however many ask; every
// access gives where the token goes and the editor headers, never stored in the endpoint. GitHub offers this client no
// revocation: sign-out removes the tokens here and sends nothing. Every test ends with a scan of the storage and the
// console for every token and device code the fake made, and the waiting attempt's user code.
import { COPILOT_HEADERS } from "@t3flare/models/copilotOAuth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { credentialBroker } from "../src/credentials/broker.ts";
import { copilotSignIn } from "../src/credentials/copilot.ts";
import { sealedStore } from "../src/credentials/sealed.ts";
import { fakeGitHubCopilot } from "./fixtures/fakeGitHubCopilot.ts";
import { gate } from "./fixtures/fakeOpenAIAuth.ts";

const LIFE = 1_800_000;

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
  let clock = Date.UTC(2026, 10, 16, 12, 0);
  const now = () => clock;
  const github = fakeGitHubCopilot({}, now);
  const kv = memory();
  const broker = credentialBroker({ kv, sealed: sealedStore(kv, "d".repeat(64), now), vendors: { copilot: copilotSignIn({ fetch: github.fetch, now }) }, now });
  const userCodes: Array<string> = [];
  return { kv, github, broker, userCodes, advance: (ms: number) => void (clock += ms), now };
};

/** Start, approve at GitHub, and ask once the interval has passed. */
const signIn = async (context: ReturnType<typeof setup>) => {
  const { device } = await context.broker.start("copilot", "copilot");
  context.userCodes.push(device!.userCode);
  context.github.approve(device!.userCode);
  context.advance(5_000);
  return context.broker.complete("copilot", "");
};

const scan = (context: ReturnType<typeof setup>) => {
  const stored = JSON.stringify([...context.kv.map.entries()]);
  const output = logged.join("\n");
  for (const secret of [...context.github.secrets(), ...context.userCodes]) {
    expect(stored).not.toContain(secret);
    expect(output).not.toContain(secret);
  }
};

const tokenTime = (now: number) => Math.floor(now / 1000) * 1000;

describe("the Credential broker with a GitHub Copilot sign-in", () => {
  it("waits sealed for the owner's approval, asking GitHub no sooner than its interval, then signs in", async () => {
    const context = setup();
    const { broker, github } = context;
    const started = await broker.start("copilot", "copilot");
    expect(started).toMatchObject({ authorizeUrl: "https://github.com/login/device", device: { userCode: expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/), intervalSeconds: 5 } });
    context.userCodes.push(started.device!.userCode);
    expect(broker.status("copilot")).toMatchObject({ kind: "copilot", pendingSince: context.now(), signedIn: false });
    // Asked too soon: GitHub is not asked.
    expect(await broker.complete("copilot", "")).toEqual({ ok: false, waiting: true, problem: "Waiting for you to enter the code at GitHub and approve." });
    expect(github.counts.polls).toBe(0);
    context.advance(5_000);
    expect(await broker.complete("copilot", "")).toMatchObject({ ok: false, waiting: true });
    expect(github.counts.polls).toBe(1);
    // The next poll's time was sealed with the attempt: asked again at once, GitHub is not asked.
    expect(await broker.complete("copilot", "")).toMatchObject({ ok: false, waiting: true });
    expect(github.counts.polls).toBe(1);
    scan(context);
    github.approve(started.device!.userCode);
    context.advance(5_000);
    const done = await broker.complete("copilot", "");
    expect(done).toMatchObject({ ok: true, status: { kind: "copilot", signedIn: true, pendingSince: null, baseUrl: "https://api.individual.githubcopilot.com", email: null } });
    expect(github.counts.polls).toBe(2);
    scan(context);
  });

  it("slows its polls when GitHub says slow_down, across asks", async () => {
    const context = setup();
    const { broker, github } = context;
    const { device } = await broker.start("copilot", "copilot");
    context.userCodes.push(device!.userCode);
    github.options.slowDown = {};
    context.advance(5_000);
    await broker.complete("copilot", "");
    expect(github.counts.polls).toBe(1);
    context.advance(5_000);
    await broker.complete("copilot", "");
    // 10 s now: not yet.
    expect(github.counts.polls).toBe(1);
    context.advance(5_000);
    await broker.complete("copilot", "");
    expect(github.counts.polls).toBe(2);
  });

  it("gives the Copilot token with where it goes and the editor headers, never the GitHub token", async () => {
    const context = setup();
    expect(await signIn(context)).toMatchObject({ ok: true });
    const access = await context.broker.access("copilot");
    expect(access).toEqual({ ok: true, accessToken: context.github.copilotTokens[0], expiresAt: tokenTime(context.now()) + LIFE, baseUrl: "https://api.individual.githubcopilot.com", headers: COPILOT_HEADERS });
    expect(JSON.stringify(access)).not.toContain(context.github.githubTokens[0]!);
    scan(context);
  });

  it("derives a new Copilot token once for many callers near its expiry; the GitHub token stays the grant", async () => {
    const context = setup();
    await signIn(context);
    context.advance(LIFE - 60_000);
    const slow = gate();
    context.github.options.copilotGate = slow.opened;
    context.github.options.onCopilot = slow.reached;
    const asks = Promise.all(Array.from({ length: 5 }, () => context.broker.access("copilot")));
    await slow.arrived;
    slow.open();
    const answers = await asks;
    expect(context.github.counts.copilotTokens).toBe(2);
    expect(new Set(answers.map((answer) => (answer.ok ? answer.accessToken : "refused")))).toEqual(new Set([context.github.copilotTokens[1]]));
    const stored = await context.broker.read("copilot");
    expect(stored?.type === "oauth" ? stored.refresh : undefined).toBe(context.github.githubTokens[0]);
    expect(context.broker.status("copilot")).toMatchObject({ signedIn: true, refreshedAt: context.now(), baseUrl: "https://api.individual.githubcopilot.com" });
    scan(context);
  });

  it("signs the endpoint out when GitHub refuses a Copilot token with an error object (the GitHub token revoked), once", async () => {
    const context = setup();
    await signIn(context);
    context.advance(LIFE);
    context.github.options.copilotStatus = 401;
    context.github.options.copilotBody = { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" };
    expect(await context.broker.access("copilot")).toMatchObject({ ok: false, signedOut: true, problem: "GitHub refused a Copilot token (HTTP 401): it is signed out" });
    expect(await context.broker.access("copilot")).toMatchObject({ ok: false, signedOut: true });
    expect(context.github.counts.copilotTokens).toBe(2);
    expect(context.broker.status("copilot")).toMatchObject({ signedIn: false, baseUrl: null, email: null, subject: null });
    expect(await context.broker.read("copilot")).toBeUndefined();
    scan(context);
  });

  it("keeps a still-valid token through a rate limit or an edge's page, and shows the trouble until a renewal succeeds", async () => {
    const context = setup();
    await signIn(context);
    context.advance(LIFE - 60_000);
    context.github.options.copilotStatus = 403;
    context.github.options.copilotBody = { message: "You have exceeded a secondary rate limit" };
    context.github.options.copilotHeaders = { "retry-after": "30" };
    expect(await context.broker.access("copilot")).toMatchObject({ ok: true, accessToken: context.github.copilotTokens[0] });
    expect(context.broker.status("copilot")).toMatchObject({ signedIn: true, problem: "GitHub gave no Copilot token (HTTP 403): it is tried again at the next use" });
    context.github.options.copilotStatus = undefined;
    expect(await context.broker.access("copilot")).toMatchObject({ ok: true, accessToken: context.github.copilotTokens[1] });
    expect(context.broker.status("copilot")).toMatchObject({ problem: null });
    // Expired, with the edge's page: a passing failure, retryable.
    context.advance(LIFE);
    context.github.options.copilotStatus = 502;
    context.github.options.copilotBody = undefined;
    expect(await context.broker.access("copilot")).toMatchObject({ ok: false, signedOut: false });
    scan(context);
  });

  it("signs out by removing the tokens and stopping the Sessions, sending nothing to GitHub", async () => {
    const context = setup();
    await signIn(context);
    const before = context.github.requests.length;
    const order: Array<string> = [];
    const out = await context.broker.signOut("copilot", { beforeRevoke: async () => void order.push(`removed: ${(await context.broker.read("copilot")) === undefined}`) });
    expect(out).toEqual({ signedOut: true, revoked: false });
    expect(order).toEqual(["removed: true"]);
    expect(context.github.requests).toHaveLength(before);
    expect(context.broker.status("copilot")).toMatchObject({ signedIn: false, baseUrl: null, expiresAt: null });
    expect(await context.broker.access("copilot")).toMatchObject({ ok: false, signedOut: true });
    scan(context);
  });

  it("drops an approval a sign-out overtook during its Copilot token exchange", async () => {
    const context = setup();
    const { device } = await context.broker.start("copilot", "copilot");
    context.userCodes.push(device!.userCode);
    context.github.approve(device!.userCode);
    context.advance(5_000);
    const slow = gate();
    context.github.options.copilotGate = slow.opened;
    context.github.options.onCopilot = slow.reached;
    const completing = context.broker.complete("copilot", "");
    await slow.arrived;
    await context.broker.signOut("copilot");
    slow.open();
    expect(await completing).toMatchObject({ ok: false, problem: expect.stringMatching(/signed out or started again/) });
    expect(await context.broker.read("copilot")).toBeUndefined();
    expect(context.broker.status("copilot")).toMatchObject({ signedIn: false, pendingSince: null });
    scan(context);
  });

  it("ends a declined attempt, and a sign-in started again replaces a waiting one", async () => {
    const context = setup();
    const first = await context.broker.start("copilot", "copilot");
    const second = await context.broker.start("copilot", "copilot");
    context.userCodes.push(first.device!.userCode, second.device!.userCode);
    context.github.approve(first.device!.userCode);
    context.advance(5_000);
    // The waiting attempt is the second, not approved: the first's approval is not taken.
    expect(await context.broker.complete("copilot", "")).toMatchObject({ ok: false, waiting: true });
    context.github.options.denied = true;
    context.advance(5_000);
    expect(await context.broker.complete("copilot", "")).toEqual({ ok: false, problem: "The sign-in was declined at GitHub: start it again to retry." });
    expect(context.broker.status("copilot")).toMatchObject({ pendingSince: null, problem: "The sign-in was declined at GitHub: start it again to retry." });
    scan(context);
  });

  it("does not seal an overtaken poll's attempt again: a sign-out, or a newer start, during the poll wins", async () => {
    for (const overtake of ["sign-out", "start"] as const) {
      const context = setup();
      const first = await context.broker.start("copilot", "copilot");
      context.userCodes.push(first.device!.userCode);
      context.advance(5_000);
      const slow = gate();
      context.github.options.pollGate = slow.opened;
      context.github.options.onPoll = slow.reached;
      const asking = context.broker.complete("copilot", "");
      await slow.arrived;
      const second = overtake === "start" ? await context.broker.start("copilot", "copilot") : (await context.broker.signOut("copilot"), undefined);
      if (second !== undefined) context.userCodes.push(second.device!.userCode);
      slow.open();
      expect(await asking).toMatchObject({ ok: false, waiting: true });
      context.github.options.pollGate = undefined;
      context.github.options.onPoll = undefined;
      if (second === undefined) {
        // Signed out: nothing waits any more, and GitHub is not asked again.
        expect(await context.broker.complete("copilot", "")).toEqual({ ok: false, problem: "No sign-in is waiting for a pasted address: start the sign-in again." });
        expect(context.broker.status("copilot").pendingSince).toBeNull();
      } else {
        // The newer attempt is the one waiting: its approval completes it, the older one's code is never asked again.
        context.github.approve(second.device!.userCode);
        context.advance(5_000);
        const polls = context.github.counts.polls;
        expect(await context.broker.complete("copilot", "")).toMatchObject({ ok: true });
        expect(context.github.counts.polls).toBe(polls + 1);
        expect(new URLSearchParams(context.github.requests.filter((request) => request.url.endsWith("/login/oauth/access_token")).at(-1)!.body).get("device_code")).not.toBe(
          new URLSearchParams(context.github.requests.filter((request) => request.url.endsWith("/login/oauth/access_token"))[0]!.body).get("device_code"),
        );
      }
      scan(context);
    }
  });

  it("shows the base URL a renewed Copilot token names", async () => {
    const context = setup();
    await signIn(context);
    expect(context.broker.status("copilot").baseUrl).toBe("https://api.individual.githubcopilot.com");
    context.advance(LIFE - 60_000);
    context.github.options.proxyHost = "proxy.business.githubcopilot.com";
    expect(await context.broker.access("copilot")).toMatchObject({ ok: true, baseUrl: "https://api.business.githubcopilot.com" });
    expect(context.broker.status("copilot").baseUrl).toBe("https://api.business.githubcopilot.com");
    scan(context);
  });
});
