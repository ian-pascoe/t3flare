// The GitHub Copilot sign-in's vendor (SPI-1166) against a fake of GitHub's device flow and Copilot token endpoint:
// the device code, one poll per ask no sooner than GitHub's interval (slowed as `slow_down` says), the GitHub token
// exchanged for a Copilot token, its renewal and what ends it, where its requests go, and no revocation. No answer holds
// a token or the device code.
import { COPILOT_CLIENT_ID, COPILOT_HEADERS, COPILOT_TOKEN_URL, copilotBaseUrl, GITHUB_ACCESS_TOKEN_URL, GITHUB_DEVICE_CODE_URL } from "@t3flare/models/copilotOAuth";
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

  it("refuses a device answer whose page is not GitHub's over https, or whose user code is not GitHub's shape", async () => {
    for (const deviceAnswer of [
      { verification_uri: "https://github.example/login/device" },
      { verification_uri: "http://github.com/login/device" },
      { user_code: "<b>AB</b>" },
      { user_code: "abcd-1234" },
    ]) {
      const { vendor } = setup({ deviceAnswer });
      await expect(startCopilotSignIn(vendor), JSON.stringify(deviceAnswer)).rejects.toThrow(/not usable/);
    }
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

  it("asks no more often than once a second, whatever interval GitHub names", async () => {
    const { github, vendor, now, advance } = setup({ deviceAnswer: { interval: 0.2 }, slowDown: { interval: 0.5 } });
    const { pending, device } = await startCopilotSignIn(vendor);
    expect(pending).toMatchObject({ intervalMs: 1_000, nextPollAt: now() + 1_000 });
    expect(device.intervalSeconds).toBe(1);
    advance(1_000);
    expect(waitingOf(await pollCopilotSignIn(vendor, pending))).toMatchObject({ intervalMs: 1_000 });
    expect(github.counts.polls).toBe(1);
  });

  it("slows down as GitHub says: to the interval it names, else 5 s more", async () => {
    // 12 s, not the 10 s that 5 s more would make.
    const { github, vendor, now, advance } = setup({ slowDown: { interval: 12 } });
    const { pending } = await startCopilotSignIn(vendor);
    advance(5_000);
    const slowed = waitingOf(await pollCopilotSignIn(vendor, pending));
    expect(slowed).toMatchObject({ intervalMs: 12_000, nextPollAt: now() + 12_000 });
    github.options.slowDown = {};
    advance(12_000);
    expect(waitingOf(await pollCopilotSignIn(vendor, slowed))).toMatchObject({ intervalMs: 17_000 });
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
      problem:
        "Signed in at GitHub, but GitHub refused a Copilot token (subscription_ended): this GitHub account needs a Copilot plan. Nothing was kept here; GitHub offers this app no revocation, so the approval stays on your GitHub account until you revoke it at github.com, under Settings, Applications.",
    });
    clean(context.github, result);
    expect(JSON.stringify(result)).not.toContain("secret-ish");
  });

  it("does not use a Copilot token that names a host outside githubcopilot.com", async () => {
    const context = setup({ proxyHost: "proxy.githubcopilot.com.evil.example" });
    expect(await signedIn(context)).toMatchObject({ ok: false, spent: true, problem: expect.stringMatching(/outside githubcopilot\.com/) });
    // Only https on a githubcopilot.com host, from its start: not a look-alike, not a path that ends in one.
    for (const host of ["proxy.evilgithubcopilot.com", "evil.example/https://api.githubcopilot.com", "evil.example/x.githubcopilot.com", "api.githubcopilot.com:8443", "githubcopilot.com"]) {
      expect(copilotBaseUrl(`tid=1;proxy-ep=${host};`), host).toBeUndefined();
    }
    expect(copilotBaseUrl("tid=1;proxy-ep=proxy.business.githubcopilot.com;")).toBe("https://api.business.githubcopilot.com");
  });

  it("does not use a Copilot token GitHub gives already expired", async () => {
    const context = setup({ copilotLife: -60 });
    expect(await signedIn(context)).toMatchObject({ ok: false, spent: true, problem: expect.stringMatching(/Copilot token was not usable/) });
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
      // GitHub's rate limits answer 403 or 429 with retry-after, or no requests left, or (secondary limits) only a message
      // naming them: passing.
      [{ copilotStatus: 403, copilotBody: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." } }, { refused: false }],
      [{ copilotStatus: 403, copilotBody: { message: "Maximum number of login attempts exceeded. Please try again later." } }, { refused: false }],
      [{ copilotStatus: 403, copilotBody: { message: "Too Many Requests" } }, { refused: false }],
      // Each wording in any case, on a 403 only; "too many" alone is not a rate limit.
      [{ copilotStatus: 403, copilotBody: { message: "API RATE LIMIT EXCEEDED" } }, { refused: false }],
      [{ copilotStatus: 403, copilotBody: { message: "Too many seats in use for your organization" } }, { refused: true, code: "http_403" }],
      [{ copilotStatus: 401, copilotBody: { message: "API rate limit exceeded" } }, { refused: true, code: "http_401" }],
      // A JSON object that is not GitHub's error object: passing.
      [{ copilotStatus: 401, copilotBody: { detail: "Unauthorized" } }, { refused: false }],
      // A code is named only in its shape: anything else of the body is not, and the status names it instead.
      [{ copilotStatus: 403, copilotBody: { message: "Forbidden", error_details: { notification_id: "Leak This Secret" } } }, { refused: true, code: "http_403" }],
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
      expect(JSON.stringify(answer)).not.toMatch(/Leak/);
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

  it("names when a rate-limited renewal may be tried again: retry-after, else the limit's reset, else a minute; at most 15", async () => {
    const credential = async (options: Parameters<typeof fakeGitHubCopilot>[0]) => {
      const context = setup();
      const result = await signedIn(context);
      if (!result.ok) throw new Error("not signed in");
      Object.assign(context.github.options, options);
      return { context, answer: await refreshCopilot(context.vendor, result.credential) };
    };
    const limited = { copilotStatus: 403, copilotBody: { message: "You have exceeded a secondary rate limit" } };
    for (const [headers, after] of [
      [{ "retry-after": "120" }, 120_000],
      [{ "retry-after": "5" }, 60_000],
      [{ "retry-after": "86400" }, 900_000],
      [{}, 60_000],
    ] as const) {
      const { context, answer } = await credential({ ...limited, copilotHeaders: headers });
      expect(answer, JSON.stringify(headers)).toMatchObject({ ok: false, refused: false, retryAt: context.now() + after });
    }
    const { context, answer } = await credential({ copilotStatus: 403, copilotBody: { message: "API rate limit exceeded" }, copilotHeaders: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "" } });
    expect(answer).toMatchObject({ retryAt: context.now() + 60_000 });
    const reset = await credential({ copilotStatus: 403, copilotBody: { message: "API rate limit exceeded" }, copilotHeaders: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.UTC(2026, 10, 16, 12, 0) / 1000) + 300) } });
    expect(reset.answer).toMatchObject({ retryAt: Date.UTC(2026, 10, 16, 12, 0) + 300_000 });
    // A 503 is passing trouble with no time named: the next ask tries again.
    const down = await credential({ copilotStatus: 503, copilotBody: { message: "Service unavailable" } });
    expect(down.answer).not.toHaveProperty("retryAt");
  });
});
