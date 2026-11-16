// The GitHub Copilot sign-in's vendor (SPI-1166) against a fake of GitHub's device flow and Copilot token endpoint:
// the device code, one poll per ask no sooner than GitHub's interval (slowed as `slow_down` says), the GitHub token
// exchanged for a Copilot token, its renewal and what ends it, where its requests go, and no revocation. No answer holds
// a token or the device code.
import { COPILOT_CLIENT_ID, COPILOT_HEADERS, COPILOT_TOKEN_URL, GITHUB_ACCESS_TOKEN_URL, GITHUB_DEVICE_CODE_URL } from "@t3flare/models/copilotOAuth";
import { describe, expect, it } from "vitest";

import { copilotSignIn, type PendingCopilotSignIn, pollCopilotSignIn, refreshCopilot, startCopilotSignIn } from "../src/credentials/copilot.ts";
import type { SignInCredential, SignInResult } from "../src/credentials/signIn.ts";
import { type FakeCopilot, fakeGitHubCopilot } from "./fixtures/fakeGitHubCopilot.ts";

const setup = (options: Parameters<typeof fakeGitHubCopilot>[0] = {}) => {
  let clock = Date.UTC(2026, 10, 16, 12, 0);
  const now = () => clock;
  const github = fakeGitHubCopilot(options, now);
  return { github, vendor: { fetch: github.fetch, now }, now, advance: (ms: number) => void (clock += ms) };
};

/** Nothing secret the fake made is in `answer`. */
const clean = (github: FakeCopilot, answer: unknown) => {
  const text = JSON.stringify(answer);
  for (const secret of github.secrets()) expect(text).not.toContain(secret);
};

const waitingOf = (result: SignInResult): PendingCopilotSignIn => {
  if (result.ok || result.waiting === undefined) throw new Error(`not waiting: ${JSON.stringify(result)}`);
  return result.waiting as PendingCopilotSignIn;
};

/** Start, approve, and poll once the interval has passed: the signed-in result. */
const signedIn = async (context: ReturnType<typeof setup>) => {
  const { pending, device } = await startCopilotSignIn(context.vendor);
  context.github.approve(device.userCode);
  context.advance(5_000);
  return pollCopilotSignIn(context.vendor, pending);
};

describe("the GitHub Copilot sign-in", () => {
  it("starts GitHub's device flow with pi-ai's client and scope, and gives the device page and the code to enter", async () => {
    const { github, vendor, now } = setup();
    const { authorizeUrl, pending, device } = await startCopilotSignIn(vendor);
    expect(authorizeUrl).toBe("https://github.com/login/device");
    expect(device).toEqual({ userCode: pending.userCode, expiresAt: now() + 900_000, intervalSeconds: 5 });
    expect(device.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(pending).toMatchObject({ intervalMs: 5_000, nextPollAt: now() + 5_000, startedAt: now() });
    expect(github.requests[0]).toMatchObject({ url: GITHUB_DEVICE_CODE_URL, method: "POST", redirect: "manual", signal: true });
    expect(Object.fromEntries(new URLSearchParams(github.requests[0]!.body))).toEqual({ client_id: COPILOT_CLIENT_ID, scope: "read:user" });
    // The page is shown the device page and code only; the device code stays in the sealed attempt.
    clean(github, { authorizeUrl, device });
  });

  it("refuses a device answer whose page is not GitHub's", async () => {
    const { vendor } = setup();
    const fetch = (async () => Response.json({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.example/login/device", expires_in: 900, interval: 5 })) as typeof globalThis.fetch;
    await expect(startCopilotSignIn({ ...vendor, fetch })).rejects.toThrow(/not usable/);
  });

  it("says why GitHub would not start, with a fixed text", async () => {
    const { vendor } = setup({ startStatus: 503 });
    await expect(startCopilotSignIn(vendor)).rejects.toThrow("GitHub did not start the device sign-in (HTTP 503): start it again.");
  });

  it("asks GitHub no sooner than its interval, and waits while the owner has not approved", async () => {
    const { github, vendor, now, advance } = setup();
    const { pending } = await startCopilotSignIn(vendor);
    // Too soon: nothing is sent, and the attempt is unchanged.
    const early = await pollCopilotSignIn(vendor, pending);
    expect(waitingOf(early)).toEqual(pending);
    expect(github.counts.polls).toBe(0);
    advance(5_000);
    const later = waitingOf(await pollCopilotSignIn(vendor, pending));
    expect(github.counts.polls).toBe(1);
    expect(later).toMatchObject({ intervalMs: 5_000, nextPollAt: now() + 5_000 });
    expect(Object.fromEntries(new URLSearchParams(github.requests.at(-1)!.body))).toMatchObject({ client_id: COPILOT_CLIENT_ID, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    expect(github.requests.at(-1)).toMatchObject({ url: GITHUB_ACCESS_TOKEN_URL, redirect: "manual", signal: true });
  });

  it("slows down as GitHub says: to the interval it names, else 5 s more", async () => {
    const { github, vendor, now, advance } = setup({ slowDown: { interval: 10 } });
    const { pending } = await startCopilotSignIn(vendor);
    advance(5_000);
    const slowed = waitingOf(await pollCopilotSignIn(vendor, pending));
    expect(slowed).toMatchObject({ intervalMs: 10_000, nextPollAt: now() + 10_000 });
    github.options.slowDown = {};
    advance(10_000);
    expect(waitingOf(await pollCopilotSignIn(vendor, slowed))).toMatchObject({ intervalMs: 15_000 });
  });

  it("on approval, exchanges the GitHub token for a Copilot token: the Copilot token is the access token, the GitHub token the refresh", async () => {
    const context = setup();
    const result = await signedIn(context);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.credential).toMatchObject({ type: "oauth", access: context.github.copilotTokens[0], refresh: context.github.githubTokens[0], subject: null, email: null });
    // Its real expiry (pi-ai's is 5 minutes short; the broker renews 5 minutes before).
    expect(result.credential.expires).toBe(Math.floor(context.now() / 1000) * 1000 + 1_800_000);
    const exchange = context.github.requests.at(-1)!;
    expect(exchange).toMatchObject({ url: COPILOT_TOKEN_URL, method: "GET", redirect: "manual", signal: true });
    expect(exchange.headers).toMatchObject({ authorization: `Bearer ${context.github.githubTokens[0]}`, accept: "application/json", ...Object.fromEntries(Object.entries(COPILOT_HEADERS).map(([name, value]) => [name.toLowerCase(), value])) });
  });

  it("ends the attempt when the owner declined, or the code lapsed, with fixed texts", async () => {
    for (const [option, text] of [
      [{ denied: true }, "The sign-in was declined at GitHub: start it again to retry."],
      [{ expired: true }, "GitHub's code lapsed before it was approved: start the sign-in again."],
    ] as const) {
      const context = setup(option);
      const { pending } = await startCopilotSignIn(context.vendor);
      context.advance(5_000);
      expect(await pollCopilotSignIn(context.vendor, pending)).toEqual({ ok: false, problem: text, spent: true });
    }
    // Lapsed here too, without asking GitHub.
    const context = setup();
    const { pending } = await startCopilotSignIn(context.vendor);
    context.advance(900_000);
    expect(await pollCopilotSignIn(context.vendor, pending)).toMatchObject({ ok: false, spent: true });
    expect(context.github.counts.polls).toBe(0);
  });

  it("keeps waiting when GitHub cannot be reached", async () => {
    const { github, vendor, advance } = setup();
    const { pending } = await startCopilotSignIn(vendor);
    github.options.down = true;
    advance(5_000);
    expect(await pollCopilotSignIn(vendor, pending)).toMatchObject({ ok: false, problem: "GitHub could not be reached: still waiting.", waiting: expect.any(Object) });
  });

  it("refuses an account GitHub gives no Copilot token (no plan), saying where to revoke the GitHub grant, without the body", async () => {
    const context = setup({ copilotStatus: 403, copilotBody: { message: "Resource not accessible", error_details: { notification_id: "subscription_ended", message: "secret-ish detail" } } });
    const result = await signedIn(context);
    expect(result).toEqual({
      ok: false,
      spent: true,
      problem: "Signed in at GitHub, but GitHub refused a Copilot token (subscription_ended): this GitHub account needs a Copilot plan. It could not be revoked here: revoke it at github.com, under Settings, Applications.",
    });
    clean(context.github, result);
    expect(JSON.stringify(result)).not.toContain("secret-ish");
  });

  it("does not use a Copilot token that names a host outside githubcopilot.com", async () => {
    const context = setup({ proxyHost: "proxy.githubcopilot.com.evil.example" });
    expect(await signedIn(context)).toMatchObject({ ok: false, spent: true, problem: expect.stringMatching(/outside githubcopilot\.com/) });
  });

  it("sends the Copilot token where it says, with the editor headers; a token without proxy-ep goes to pi-ai's default", async () => {
    const context = setup({ proxyHost: "proxy.business.githubcopilot.com" });
    const result = await signedIn(context);
    if (!result.ok) throw new Error("not signed in");
    const vendor = copilotSignIn(context.vendor);
    expect(vendor.use?.(result.credential)).toEqual({ baseUrl: "https://api.business.githubcopilot.com", headers: COPILOT_HEADERS });
    expect(vendor.use?.({ ...result.credential, access: "tid=1;exp=2" })).toMatchObject({ baseUrl: "https://api.individual.githubcopilot.com" });
  });

  it("renews the Copilot token with the GitHub token, which stays", async () => {
    const context = setup();
    const result = await signedIn(context);
    if (!result.ok) throw new Error("not signed in");
    context.advance(1_700_000);
    const renewed = await refreshCopilot(context.vendor, result.credential);
    expect(renewed).toMatchObject({ ok: true, credential: { access: context.github.copilotTokens[1], refresh: context.github.githubTokens[0] } });
  });

  it("ends the sign-in at a refusal with an error object (a revoked GitHub token, a plan ended), and retries anything else", async () => {
    const credential = async () => {
      const context = setup();
      const result = await signedIn(context);
      if (!result.ok) throw new Error("not signed in");
      return { context, credential: result.credential as SignInCredential };
    };
    const cases: ReadonlyArray<readonly [Partial<Parameters<typeof fakeGitHubCopilot>[0]>, { readonly refused: boolean; readonly code?: string }]> = [
      // A revoked GitHub token: the fake refuses a token it did not issue, with GitHub's error object.
      [{ copilotStatus: 401, copilotBody: { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" } }, { refused: true, code: "http_401" }],
      [{ copilotStatus: 403, copilotBody: { message: "Forbidden", error_details: { notification_id: "subscription_ended" } } }, { refused: true, code: "subscription_ended" }],
      [{ copilotStatus: 400, copilotBody: { error: "invalid_request" } }, { refused: true, code: "invalid_request" }],
      // GitHub's rate limits answer 403 or 429 with retry-after, or no requests left: passing.
      [{ copilotStatus: 403, copilotBody: { message: "You have exceeded a secondary rate limit" }, copilotHeaders: { "retry-after": "60" } }, { refused: false }],
      [{ copilotStatus: 403, copilotBody: { message: "API rate limit exceeded" }, copilotHeaders: { "x-ratelimit-remaining": "0" } }, { refused: false }],
      // An edge's page, a bare JSON value, another status: passing.
      [{ copilotStatus: 403 }, { refused: false }],
      [{ copilotStatus: 401, copilotBody: "Unauthorized" }, { refused: false }],
      [{ copilotStatus: 404, copilotBody: { message: "Not Found" } }, { refused: false }],
      [{ copilotStatus: 503, copilotBody: { message: "Service unavailable" } }, { refused: false }],
    ];
    for (const [options, expected] of cases) {
      const { context, credential: held } = await credential();
      Object.assign(context.github.options, options);
      const answer = await refreshCopilot(context.vendor, held);
      expect(answer, JSON.stringify(options)).toMatchObject({ ok: false, ...expected });
      clean(context.github, answer);
    }
    const { context, credential: held } = await credential();
    context.github.options.down = true;
    expect(await refreshCopilot(context.vendor, held)).toMatchObject({ ok: false, refused: false, problem: "GitHub's Copilot token endpoint could not be reached" });
  });

  it("revokes nothing: GitHub takes this client's secret to revoke, and it has none", async () => {
    const context = setup();
    const result = await signedIn(context);
    if (!result.ok) throw new Error("not signed in");
    const before = context.github.requests.length;
    expect(await copilotSignIn(context.vendor).revoke(result.credential)).toEqual({ confirmed: false });
    expect(context.github.requests).toHaveLength(before);
  });
});
