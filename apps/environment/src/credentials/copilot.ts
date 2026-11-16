// @effect-diagnostics globalDate:off
// A GitHub Copilot plan through GitHub's device flow (SPI-1166), as pi-ai 1.5.0 signs in to Copilot
// (`dist/auth/oauth/github-copilot.js`; its facts in `@t3flare/models/copilotOAuth`, pinned against pi-ai's own flow):
// the panel shows the code GitHub gives, the owner enters it at github.com/login/device and approves, and the
// Environment polls GitHub until it is approved (RFC 8628; GitHub's "Device flow", docs.github.com/en/apps/oauth-apps/
// building-oauth-apps/authorizing-oauth-apps#device-flow). Two tokens:
// - the long-lived GitHub token (`refresh`), the sign-in's grant, kept sealed by the broker and sent only to GitHub's
//   Copilot token endpoint;
// - the short-lived Copilot token (`access`, about 30 minutes), got from it at the sign-in and renewed by the broker
//   with it before each expiry. It names its API host (`proxy-ep`), which is where its requests go (`use`, with the
//   editor headers): never stored in the endpoint.
//
// Where this departs from pi-ai's flow:
// - The attempt (the device code, never shown) is kept sealed by the broker between the start and the approval, and is
//   polled once per panel ask, no sooner than GitHub's interval (slowed as `slow_down` says), never in a loop held in
//   an isolate's memory (pi-ai's `login()` is; SPI-1161 Q1).
// - `expires` is the Copilot token's real expiry (pi-ai stores it 5 minutes short); the broker renews 5 minutes before.
// - No model policies are switched on at the sign-in (pi-ai's login enables "unconfigured" models for the account).
// - A Copilot token naming a host outside GitHub Copilot's domain is not used.
// - github.com only: no GitHub Enterprise domain.
// - Revocation: GitHub revokes an app's token only with the app's client secret, which this public client has none of,
//   so `revoke` sends nothing and never confirms. Sign-out deletes the tokens here; the grant stays on the owner's
//   GitHub account until the owner revokes it at github.com, under Settings, Applications.
// - What ends the sign-in at a renewal: a 400, 401 or 403 whose body is an error object (GitHub's `{ message }` or an
//   OAuth error) and which is not a rate limit (`retry-after`, `x-ratelimit-remaining: 0`, or a message naming a rate
//   limit or too many sign-in attempts, GitHub's secondary limits): the GitHub token was revoked, or the account has no
//   Copilot plan any more. Anything else (an edge's page, a 5xx, a rate limit, no answer) is passing trouble, retried
//   at the next use (ADR-0018 item 11, after SPI-1165's rule, item 10).
//
// Every failure is one of our fixed texts: never a token, the device code, or GitHub's body.
import {
  COPILOT_CLIENT_ID,
  COPILOT_DEFAULT_BASE_URL,
  COPILOT_HEADERS,
  COPILOT_SCOPE,
  COPILOT_TOKEN_URL,
  COPILOT_USER_AGENT,
  copilotBaseUrl,
  DEVICE_GRANT_TYPE,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
} from "@t3flare/models/copilotOAuth";

import { isRecord, oauthRequestOptions } from "./oauth.ts";
import type { DeviceCode, RefreshResult, SignInCredential, SignInResult, SignInVendor } from "./signIn.ts";

export interface CopilotVendor {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Each request's bound (`OAUTH_TIMEOUT_MS`; shorter in tests). */
  readonly timeoutMs?: number;
}

/** A sign-in started and not yet approved: kept sealed until GitHub says it is. */
export interface PendingCopilotSignIn {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  /** GitHub's poll interval (ms), slowed by each `slow_down`. */
  readonly intervalMs: number;
  /** No poll before this (ms). */
  readonly nextPollAt: number;
  /** When GitHub's device code lapses (ms). */
  readonly expiresAt: number;
  readonly startedAt: number;
}

/** RFC 8628 §3.2: without an interval, 5 s; never below a second (pi-ai's floor). */
const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;
/** RFC 8628 §3.5: `slow_down` adds 5 s, unless GitHub names the new interval. */
const SLOW_DOWN_MS = 5_000;
/** GitHub's user codes: `XXXX-XXXX` (letters and digits). */
const USER_CODE = /^[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?$/;
/** GitHub's own device page: the only address the panel links to for this sign-in. */
const DEVICE_PAGE_HOST = "github.com";

const FORM = { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": COPILOT_USER_AGENT } as const;

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** GitHub's poll interval (seconds) as ms, never below a second; `fallback` when it names none. */
const intervalOf = (seconds: unknown, fallback: number): number => (positive(seconds) ? Math.max(MIN_INTERVAL_MS, Math.floor(seconds * 1000)) : fallback);

/** The shape of a code from GitHub that a text may name (`invalid_grant`, `subscription_ended`): never anything else of a body. */
const CODE = /^[a-z_]{1,64}$/;
const codeOf = (value: unknown): string | undefined => (typeof value === "string" && CODE.test(value) ? value : undefined);

/** A new attempt: GitHub's device page and code for the owner, and what the polls need, kept sealed. */
export const startCopilotSignIn = async (vendor: CopilotVendor): Promise<{ readonly authorizeUrl: string; readonly pending: PendingCopilotSignIn; readonly device: DeviceCode }> => {
  let response: Response;
  try {
    response = await vendor.fetch(GITHUB_DEVICE_CODE_URL, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ client_id: COPILOT_CLIENT_ID, scope: COPILOT_SCOPE }).toString(),
      ...oauthRequestOptions({ timeoutMs: vendor.timeoutMs }),
    });
  } catch {
    throw new Error("GitHub's device sign-in could not be reached: start it again.");
  }
  if (!response.ok) throw new Error(`GitHub did not start the device sign-in (HTTP ${response.status}): start it again.`);
  const body: unknown = await response.json().catch(() => undefined);
  if (!isRecord(body)) throw new Error("GitHub's answer to the device sign-in was not usable: start it again.");
  const { device_code, user_code, verification_uri, expires_in, interval } = body;
  let page: URL | undefined;
  try {
    page = typeof verification_uri === "string" ? new URL(verification_uri) : undefined;
  } catch {
    page = undefined;
  }
  if (
    typeof device_code !== "string" ||
    device_code === "" ||
    typeof user_code !== "string" ||
    !USER_CODE.test(user_code) ||
    page === undefined ||
    page.protocol !== "https:" ||
    page.hostname !== DEVICE_PAGE_HOST ||
    !positive(expires_in) ||
    (interval !== undefined && !positive(interval))
  ) {
    throw new Error("GitHub's answer to the device sign-in was not usable: start it again.");
  }
  const now = vendor.now();
  const intervalMs = intervalOf(interval, DEFAULT_INTERVAL_MS);
  const pending: PendingCopilotSignIn = {
    deviceCode: device_code,
    userCode: user_code,
    verificationUri: page.toString(),
    intervalMs,
    // RFC 8628 §3.5: the first poll waits an interval too.
    nextPollAt: now + intervalMs,
    expiresAt: now + expires_in * 1000,
    startedAt: now,
  };
  return { authorizeUrl: pending.verificationUri, pending, device: { userCode: user_code, expiresAt: pending.expiresAt, intervalSeconds: intervalMs / 1000 } };
};

/**
 * A GitHub rate limit's message: its secondary limits ("You have exceeded a secondary rate limit"), its primary ("API
 * rate limit exceeded") and its sign-in throttle ("Maximum number of login attempts exceeded", "too many requests").
 */
const RATE_LIMIT_MESSAGE = /rate limit|too many|login attempts/i;

/**
 * GitHub's error object (its API's `{ message }`, or an OAuth error), a code from it, and whether its message names a
 * rate limit; never the rest of the body.
 */
const githubErrorOf = async (response: Response): Promise<{ readonly errorObject: boolean; readonly code: string | undefined; readonly rateLimit: boolean }> => {
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return { errorObject: false, code: undefined, rateLimit: false };
  }
  if (!isRecord(body)) return { errorObject: false, code: undefined, rateLimit: false };
  const details = isRecord(body.error_details) ? body.error_details : undefined;
  return {
    errorObject: typeof body.message === "string" || typeof body.error === "string",
    code: codeOf(body.error) ?? codeOf(details?.notification_id),
    rateLimit: typeof body.message === "string" && RATE_LIMIT_MESSAGE.test(body.message),
  };
};

/**
 * GitHub's rate limits answer 403 or 429 with `retry-after`, no requests left, or (a secondary limit) only a message
 * naming it: passing, never a refusal.
 */
const rateLimited = (response: Response, rateLimitMessage: boolean): boolean =>
  rateLimitMessage || response.headers.get("retry-after") !== null || response.headers.get("x-ratelimit-remaining") === "0";

type CopilotToken =
  | { readonly ok: true; readonly token: string; readonly expires: number }
  | { readonly ok: false; readonly refused: boolean; readonly status?: number; readonly code?: string; readonly problem: string };

/** A Copilot token for `githubToken` (pi-ai's request: the bearer and the editor headers), or why not. */
const copilotToken = async (vendor: CopilotVendor, githubToken: string): Promise<CopilotToken> => {
  let response: Response;
  try {
    response = await vendor.fetch(COPILOT_TOKEN_URL, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${githubToken}`, ...COPILOT_HEADERS },
      ...oauthRequestOptions({ timeoutMs: vendor.timeoutMs }),
    });
  } catch {
    return { ok: false, refused: false, problem: "GitHub's Copilot token endpoint could not be reached" };
  }
  if (!response.ok) {
    const { errorObject, code, rateLimit } = await githubErrorOf(response);
    const refused = [400, 401, 403].includes(response.status) && errorObject && !rateLimited(response, rateLimit);
    return {
      ok: false,
      refused,
      status: response.status,
      ...(code === undefined ? {} : { code }),
      problem: refused ? `GitHub refused a Copilot token (${code ?? `HTTP ${response.status}`})` : `GitHub gave no Copilot token (HTTP ${response.status})`,
    };
  }
  const body: unknown = await response.json().catch(() => undefined);
  const now = vendor.now();
  if (!isRecord(body) || typeof body.token !== "string" || body.token === "" || !positive(body.expires_at) || body.expires_at * 1000 <= now) {
    return { ok: false, refused: false, problem: "GitHub's Copilot token was not usable" };
  }
  // Its requests go where it says; a host outside GitHub Copilot's domain is not one we send it to.
  if (copilotBaseUrl(body.token) === undefined) return { ok: false, refused: false, problem: "GitHub's Copilot token names an API host outside githubcopilot.com" };
  return { ok: true, token: body.token, expires: body.expires_at * 1000 };
};

/** After GitHub issued its token but the sign-in did not keep it: nothing is stored, and only the owner can revoke it. */
const LEFT = " Nothing was kept here; GitHub offers this app no revocation, so the approval stays on your GitHub account until you revoke it at github.com, under Settings, Applications.";
const LAPSED = "GitHub's code lapsed before it was approved: start the sign-in again.";

/**
 * Asks GitHub once whether `pending` was approved (no sooner than its interval allows), and on approval gets the first
 * Copilot token. A still-waiting attempt comes back as `waiting`, its next poll's time in it.
 */
export const pollCopilotSignIn = async (vendor: CopilotVendor, pending: PendingCopilotSignIn): Promise<SignInResult> => {
  const now = vendor.now();
  if (now >= pending.expiresAt) return { ok: false, problem: LAPSED, spent: true };
  const wait = (problem: string, intervalMs = pending.intervalMs): SignInResult => {
    const next: PendingCopilotSignIn = { ...pending, intervalMs, nextPollAt: vendor.now() + intervalMs };
    return { ok: false, problem, waiting: next };
  };
  const waiting = "Waiting for you to enter the code at GitHub and approve.";
  if (now < pending.nextPollAt) return { ok: false, problem: waiting, waiting: pending };
  let response: Response;
  try {
    response = await vendor.fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ client_id: COPILOT_CLIENT_ID, device_code: pending.deviceCode, grant_type: DEVICE_GRANT_TYPE }).toString(),
      ...oauthRequestOptions({ timeoutMs: vendor.timeoutMs }),
    });
  } catch {
    return wait("GitHub could not be reached: still waiting.");
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(body)) return wait(`GitHub did not answer the sign-in's poll (HTTP ${response.status}): still waiting.`);
  if (typeof body.access_token !== "string" || body.access_token === "") {
    // GitHub answers a poll 200 with an OAuth error (RFC 8628 §3.5).
    switch (body.error) {
      case "authorization_pending":
        return wait(waiting);
      case "slow_down":
        return wait(waiting, intervalOf(body.interval, pending.intervalMs + SLOW_DOWN_MS));
      case "expired_token":
        return { ok: false, problem: LAPSED, spent: true };
      case "access_denied":
        return { ok: false, problem: "The sign-in was declined at GitHub: start it again to retry.", spent: true };
      default: {
        const code = codeOf(body.error);
        return code !== undefined
          ? { ok: false, problem: `GitHub refused the device sign-in (${code}): start it again.`, spent: true }
          : wait("GitHub's answer to the sign-in's poll was not usable: still waiting.");
      }
    }
  }
  const githubToken = body.access_token;
  const copilot = await copilotToken(vendor, githubToken);
  if (!copilot.ok) {
    const why = copilot.refused ? `${copilot.problem}: this GitHub account needs a Copilot plan.` : `${copilot.problem}: start the sign-in again.`;
    return { ok: false, problem: `Signed in at GitHub, but ${why}${LEFT}`, spent: true };
  }
  return {
    ok: true,
    credential: {
      type: "oauth",
      access: copilot.token,
      refresh: githubToken,
      expires: copilot.expires,
      scopes: typeof body.scope === "string" ? body.scope.split(/[\s,]+/).filter(Boolean) : [],
      subject: null,
      email: null,
    },
  };
};

/** A new Copilot token from the GitHub token, which does not change; or why not (`refused` ends the sign-in). */
export const refreshCopilot = async (vendor: CopilotVendor, credential: SignInCredential): Promise<RefreshResult> => {
  const copilot = await copilotToken(vendor, credential.refresh);
  if (!copilot.ok) {
    return copilot.refused
      ? { ok: false, refused: true, code: copilot.code ?? `http_${copilot.status ?? 0}`, problem: copilot.problem }
      : { ok: false, refused: false, ...(copilot.code === undefined ? {} : { code: copilot.code }), problem: copilot.problem };
  }
  return { ok: true, credential: { ...credential, access: copilot.token, expires: copilot.expires } };
};

/** Where a Copilot token's requests go (the host it names) and the editor headers they take. */
export const copilotUse = (credential: SignInCredential) => ({ baseUrl: copilotBaseUrl(credential.access) ?? COPILOT_DEFAULT_BASE_URL, headers: { ...COPILOT_HEADERS } });

/** A GitHub Copilot plan as the Credential broker's vendor for the `copilot` sign-in. */
export const copilotSignIn = (vendor: CopilotVendor): SignInVendor => ({
  start: () => startCopilotSignIn(vendor),
  // SAFETY: the broker hands back exactly the attempt `start` made (sealed in between), so it is this module's own shape.
  complete: (pending) => pollCopilotSignIn(vendor, pending as unknown as PendingCopilotSignIn),
  refresh: (credential) => refreshCopilot(vendor, credential),
  // GitHub revokes this client's tokens only with its secret, which it has none of: nothing is sent, never confirmed.
  revoke: () => Promise.resolve({ confirmed: false }),
  use: copilotUse,
});
