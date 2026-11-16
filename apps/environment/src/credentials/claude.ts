// @effect-diagnostics globalDate:off
// A Claude subscription (Pro or Max) through Claude Code's OAuth sign-in (SPI-1165), in pi-ai 1.5.0's copy-code form
// (`dist/auth/oauth/anthropic.js` `loginAnthropicCopyCode`): the owner opens claude.ai's authorize page, approves, and
// Anthropic's page shows a code (`code#state`) that the owner pastes into the Harness panel. The client, URLs and scopes are
// pi-ai's (`@t3flare/models/claudeOAuth`, pinned against pi-ai's own flow). The terms-of-service risk of using Claude
// Code's client outside Claude Code is the owner's, chosen knowingly (ADR-0018's SPI-1165 item).
//
// Where this departs from pi-ai's flow:
// - The attempt (state and PKCE verifier) is kept sealed by the broker between the start and the paste, never in an
//   isolate's memory (pi-ai's `login()` lost it in the spike, SPI-1161 Q1).
// - The state is a random value of its own, not the verifier: pi-ai sends the verifier as the state, which puts it in the
//   browser's address and on Anthropic's page, beside the code it protects. The pasted state must match; pi-ai accepts a
//   paste without one.
// - The access token must be in the form pi-ai recognises as a subscription token (`sk-ant-oat…`), or the requests would
//   go out as an API key's; the grant must include model use (`user:inference`).
// - `expires` is the token's real expiry (pi-ai stores it 5 minutes short); the broker renews 5 minutes before it.
// - Revocation: Anthropic offers none to apps (the spike: `platform.claude.com/v1/oauth/revoke` answers 404, and
//   `console.anthropic.com`'s serves a challenge to a Worker), so `revoke` sends nothing and never confirms. Sign-out
//   deletes the tokens here; the grant stays on the owner's account until the owner removes it at claude.ai.
//
// Every failure is one of our fixed texts: never a token, a code, the verifier, or Anthropic's body.
import { CLAUDE_AUTHORIZE_URL, CLAUDE_CLIENT_ID, CLAUDE_INFERENCE_SCOPE, CLAUDE_OAUTH_TOKEN_MARK, CLAUDE_REDIRECT_URI, CLAUDE_SCOPES, CLAUDE_TOKEN_URL } from "@t3flare/models/claudeOAuth";

import { isRecord, oauthErrorCode, oauthErrorOf, oauthRequestOptions, pkceChallenge, random } from "./oauth.ts";
import type { RefreshResult, SignInCredential, SignInResult, SignInVendor } from "./signIn.ts";

export interface ClaudeVendor {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Each request's bound (`OAUTH_TIMEOUT_MS`; shorter in tests). */
  readonly timeoutMs?: number;
}

/** A sign-in started and not yet completed: kept sealed until the owner pastes the code. */
export interface PendingClaudeSignIn {
  readonly state: string;
  readonly verifier: string;
  readonly startedAt: number;
}

/**
 * A refresh answer that does not end the sign-in though its status is 400, 401 or 403: the vendor's passing trouble.
 * Every other such refusal with a JSON body (an OAuth error, or Anthropic's API error) ends it: the refresh token is
 * gone (rotated away, expired, or the grant removed at claude.ai), so a removed grant signs the endpoint out instead of
 * failing every turn as "retry". A body that is not JSON (an edge's HTML page, nothing) is passing trouble, retried.
 * The accepted cost: a JSON 400, 401 or 403 during an incident at Anthropic signs the owner out (sign in again; the old
 * grant stays at claude.ai). What Anthropic answers for a removed grant is unverified.
 */
const PASSING_CODES: ReadonlySet<string> = new Set(["temporarily_unavailable", "server_error", "slow_down"]);

/** A new attempt: its authorize URL for the owner's browser, and what the paste is checked against. */
export const startClaudeSignIn = async (input: { readonly now?: () => number } = {}): Promise<{ readonly authorizeUrl: string; readonly pending: PendingClaudeSignIn }> => {
  // pi-ai's verifier is 32 random bytes; the state is as long, and its own.
  const pending: PendingClaudeSignIn = { state: random(32), verifier: random(32), startedAt: (input.now ?? Date.now)() };
  const challenge = await pkceChallenge(pending.verifier);
  const url = new URL(CLAUDE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_CLIENT_ID,
    response_type: "code",
    redirect_uri: CLAUDE_REDIRECT_URI,
    scope: CLAUDE_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: pending.state,
  }).toString();
  return { authorizeUrl: url.toString(), pending };
};

const WHOLE = "Copy all of the code Anthropic shows after you approve: it is two parts joined by #. Paste it here whole.";
const CALLBACK = new URL(CLAUDE_REDIRECT_URI);
/** Whether a paste starts with a URL scheme (`https://`, …). */
const hasScheme = (text: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
/** Quotes a paste may come wrapped in (from a chat or a note): straight, curly or backticks. */
const QUOTED = /^(["'`\u2018\u201C])(.*)(["'`\u2019\u201D])$/s;
/**
 * What neither half of a code may hold: space, or the characters that join them (`#`) or an address's query
 * (`? & =`). A paste holding them is not what Anthropic's page shows, so it is asked for again, never exchanged.
 */
const NOT_IN_CODE = /[\s#?&=]/;

/**
 * The pasted code and state: `code#state` as Anthropic's page shows it, or that page's own address (its `code` and
 * `state` in the query). Any other address is refused before anything is sent: the authorize link itself carries this
 * attempt's state and a `code` parameter, and must not spend the attempt.
 */
const pastedCode = (pasted: string): { readonly code: string; readonly state: string } | string => {
  const trimmed = pasted.trim();
  const text = (QUOTED.exec(trimmed)?.[2] ?? trimmed).trim();
  let code: string | null = null;
  let state: string | null = null;
  if (hasScheme(text) || text.startsWith(`${CALLBACK.host}/`)) {
    let url: URL;
    try {
      url = new URL(hasScheme(text) ? text : `https://${text}`);
    } catch {
      return WHOLE;
    }
    if (url.protocol !== CALLBACK.protocol || url.host !== CALLBACK.host || url.pathname !== CALLBACK.pathname) {
      return `That is not the page Anthropic shows the code on (${CLAUDE_REDIRECT_URI}): ${WHOLE}`;
    }
    code = url.searchParams.get("code");
    state = url.searchParams.get("state");
  } else if (text.includes("#")) {
    const at = text.indexOf("#");
    code = text.slice(0, at);
    state = text.slice(at + 1);
  }
  if (code === null || state === null || code === "" || state === "" || NOT_IN_CODE.test(code) || NOT_IN_CODE.test(state)) return WHOLE;
  return { code, state };
};

/** A JSON POST to Anthropic's token endpoint, bounded, never following a redirect (the body holds a code or a token). */
const postJson = (vendor: ClaudeVendor, body: Record<string, string>): Promise<Response> =>
  vendor.fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    ...oauthRequestOptions({ timeoutMs: vendor.timeoutMs }),
  });

interface TokenAnswer {
  readonly access: string;
  readonly refresh: string | undefined;
  readonly expiresIn: number;
  readonly scopes: ReadonlyArray<string> | undefined;
  readonly subject: string | null;
  readonly email: string | null;
}

/** Anthropic's token answer (`access_token`, `refresh_token`, `expires_in`, `scope`, `account`, …), or undefined. */
const tokenAnswer = (body: unknown): TokenAnswer | undefined => {
  if (!isRecord(body)) return undefined;
  const { access_token, refresh_token, expires_in, scope, account } = body;
  if (typeof access_token !== "string" || access_token === "") return undefined;
  if (typeof expires_in !== "number" || !Number.isFinite(expires_in) || expires_in <= 0) return undefined;
  return {
    access: access_token,
    refresh: typeof refresh_token === "string" && refresh_token !== "" ? refresh_token : undefined,
    expiresIn: expires_in,
    scopes: typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : undefined,
    subject: isRecord(account) && typeof account.uuid === "string" ? account.uuid : null,
    email: isRecord(account) && typeof account.email_address === "string" ? account.email_address : null,
  };
};

/** The token form pi-ai gives Claude Code's request shape (`isOAuthToken`): without it, requests would go as an API key's. */
const subscriptionToken = (access: string): boolean => access.includes(CLAUDE_OAUTH_TOKEN_MARK);

const exchangeProblem = (status: number, code: string | undefined): string =>
  code === "invalid_grant"
    ? "Anthropic refused the sign-in code (invalid_grant): it expired or was already used. Start the sign-in again."
    : `Anthropic did not complete the sign-in (HTTP ${status}${code === undefined ? "" : `, ${code}`}): start it again.`;

/**
 * Completes `pending` with the owner's pasted code: the state checked, the code exchanged with the PKCE verifier, the
 * grant's token form and model-use scope checked. A grant it does not keep cannot be revoked (Anthropic offers no
 * revocation), so the problem says where to remove it.
 */
export const completeClaudeSignIn = async (vendor: ClaudeVendor, pending: PendingClaudeSignIn, pasted: string): Promise<SignInResult> => {
  const parsed = pastedCode(pasted);
  if (typeof parsed === "string") return { ok: false, problem: parsed };
  if (parsed.state !== pending.state) return { ok: false, problem: "This code does not belong to the sign-in in progress: start the sign-in again and paste the code it leads to." };
  let response: Response;
  try {
    response = await postJson(vendor, {
      grant_type: "authorization_code",
      client_id: CLAUDE_CLIENT_ID,
      code: parsed.code,
      state: parsed.state,
      redirect_uri: CLAUDE_REDIRECT_URI,
      code_verifier: pending.verifier,
    });
  } catch {
    return { ok: false, problem: "Anthropic's token endpoint could not be reached: paste the code again, or start again." };
  }
  if (!response.ok) return { ok: false, problem: exchangeProblem(response.status, await oauthErrorCode(response)), spent: true };
  const answer = tokenAnswer(await response.json().catch(() => undefined));
  const left = " It could not be revoked here: remove it at claude.ai, under Settings, Claude Code.";
  if (answer === undefined || answer.refresh === undefined) return { ok: false, problem: `Anthropic's answer to the sign-in was not a usable token set: start the sign-in again.${left}`, spent: true };
  if (!subscriptionToken(answer.access)) {
    return { ok: false, problem: `Anthropic's token is not in the form t3flare and pi-ai know for a Claude subscription, so its requests would fail: please report it.${left}`, spent: true };
  }
  if (answer.scopes !== undefined && !answer.scopes.includes(CLAUDE_INFERENCE_SCOPE)) {
    return { ok: false, problem: `Signed in, but Anthropic did not allow model use (user:inference): start again and allow it.${left}`, spent: true };
  }
  return {
    ok: true,
    credential: {
      type: "oauth",
      access: answer.access,
      refresh: answer.refresh,
      expires: vendor.now() + answer.expiresIn * 1000,
      scopes: answer.scopes ?? [],
      subject: answer.subject,
      email: answer.email,
    },
  };
};

/** A refresh at Anthropic: the new access token with its replacement refresh token (it rotates on every refresh), or why not. */
export const refreshClaude = async (vendor: ClaudeVendor, credential: SignInCredential): Promise<RefreshResult> => {
  let response: Response;
  try {
    response = await postJson(vendor, { grant_type: "refresh_token", client_id: CLAUDE_CLIENT_ID, refresh_token: credential.refresh });
  } catch {
    return { ok: false, refused: false, problem: "Anthropic's token endpoint could not be reached to renew the Claude sign-in" };
  }
  if (!response.ok) {
    const { json, code } = await oauthErrorOf(response);
    if ([400, 401, 403].includes(response.status) && json && (code === undefined || !PASSING_CODES.has(code))) {
      const named = code ?? `HTTP ${response.status}`;
      return { ok: false, refused: true, code: code ?? `http_${response.status}`, problem: `Claude refused to renew the sign-in (${named})` };
    }
    return { ok: false, refused: false, ...(code === undefined ? {} : { code }), problem: `Anthropic did not renew the Claude sign-in (HTTP ${response.status})` };
  }
  const answer = tokenAnswer(await response.json().catch(() => undefined));
  if (answer === undefined || !subscriptionToken(answer.access)) return { ok: false, refused: false, problem: "Anthropic's renewal was not a usable token set" };
  return {
    ok: true,
    credential: {
      ...credential,
      access: answer.access,
      // Anthropic rotates it on every refresh; a renewal without one keeps the current token.
      refresh: answer.refresh ?? credential.refresh,
      expires: vendor.now() + answer.expiresIn * 1000,
      ...(answer.scopes === undefined ? {} : { scopes: answer.scopes }),
    },
  };
};

/** The Claude subscription as the Credential broker's vendor for the `claude` sign-in. */
export const claudeSignIn = (vendor: ClaudeVendor): SignInVendor => ({
  start: ({ now }) => startClaudeSignIn({ now }),
  // SAFETY: the broker hands back exactly the attempt `start` made (sealed in between), so it is this module's own shape.
  complete: (pending, pasted) => completeClaudeSignIn(vendor, pending as unknown as PendingClaudeSignIn, pasted),
  refresh: (credential) => refreshClaude(vendor, credential),
  // Anthropic offers no revocation to apps: nothing is sent, and it is never confirmed.
  revoke: () => Promise.resolve({ confirmed: false }),
});
