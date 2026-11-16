// A sign-in endpoint on the model relay (SPI-1171). The Environment gives the relay a sign-in's target per request: the
// Credential broker's access token, asked for at that request (renewed first when near its expiry, so a token renewed
// mid-thread is the next request's), as a bearer, at the base URL the sign-in's kind allows (`signInRequestTarget`, the
// Session's rule). This module is everything the relay does for a sign-in beyond that:
//
// - Only the kind's inference paths are carried (`SIGN_IN_RELAY_PATHS`: Messages, Responses), as a POST; any other path
//   below the vendor's base URL (an account's or a key-minting call) is refused before the vendor is asked.
// - The body is read whole (the model-routed URL's cap) and shaped by the Session's own table (`SIGN_IN_REQUESTS`): the
//   body's rules (ChatGPT plan usage's, Copilot's), then the relay's own headers and body rule (Claude's betas, headers
//   and identity block; Copilot's dynamic headers). A body that is no JSON, or that the rules leave as it was, goes on
//   byte for byte, and a request the CLI did not stream is not made a streamed one.
// - When the broker gives no token (signed out, its renewal refused, or a passing failure), the CLI gets an error in its
//   API's own shape whose message names the sign-in (the Session's text), and the process's last answer is that failure,
//   as SPI-1172's table classes it, so t3 shows it. A passing failure carries `retry-after` while the vendor's back-off
//   holds, so a CLI's retries wait for it rather than spin.
// - The log names which token went by a short hash prefix, never the token.
import { isRecord, type SignIn } from "@t3flare/models/endpoints";
import { type DescribedFailure, modelFailureOf } from "@t3flare/models/failures";
import { type RelaySignInRefusal, signInRefusalOutcome, signInRelayAllows } from "@t3flare/models/relay";

import { credentialFailure } from "../session/credentialFailure.ts";
import { SIGN_IN_REQUESTS } from "../session/signInRequests.ts";
import { relayErrorBody } from "./relayFailures.ts";
import { declaredLength, MAX_ROUTED_BODY_BYTES, readCapped } from "./routedBody.ts";

/** Why the relay does not carry this request on a `kind` sign-in (404), or undefined when it does. */
export const signInPathRefusal = (kind: SignIn, method: string, path: string): { readonly status: 404; readonly why: string } | undefined =>
  signInRelayAllows(kind, method, path) ? undefined : { status: 404, why: `a ${kind} sign-in carries only its inference calls (${method} ${path} is not one)` };

/** A sign-in request's body, read whole (`routed` when the model-routed URL read it already), or 413 past the cap. */
export const signInBody = async (request: Request, routed: Uint8Array | undefined): Promise<{ readonly bytes: Uint8Array | undefined } | { readonly status: 413; readonly why: string }> => {
  if (routed !== undefined || request.method === "GET" || request.method === "HEAD") return { bytes: routed };
  const read = await readCapped(request.body, declaredLength(request.headers));
  return "tooLarge" in read ? { status: 413, why: `the body is over ${MAX_ROUTED_BODY_BYTES} bytes` } : { bytes: read.bytes };
};

const parsed = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * The body with the CLI's own `stream` back: a rule that forces streaming (plan usage's `stream: true`, which OpenAI
 * requires) must not turn a CLI's non-streaming call into a stream it cannot read. Such a call is the vendor's to refuse.
 */
const withOwnStream = (shaped: unknown, own: Record<string, unknown>): unknown => {
  if (!isRecord(shaped) || own.stream === true) return shaped;
  const { stream: _forced, ...rest } = shaped;
  return "stream" in own ? { ...rest, stream: own.stream } : rest;
};

/**
 * A `kind` sign-in's request as the relay sends it: the body after the sign-in's rules (`bytes` itself when they change
 * nothing, or it is no JSON; undefined for none), and the headers they add.
 */
export const signInRequest = (kind: SignIn, bytes: Uint8Array | undefined, incoming: Headers): { readonly body: Uint8Array | undefined; readonly changed: boolean; readonly headers: Record<string, string> } => {
  const rules = SIGN_IN_REQUESTS[kind];
  const json = bytes === undefined ? undefined : parsed(bytes);
  if (json === undefined) return { body: bytes, changed: false, headers: rules?.relay?.headers?.(undefined, incoming) ?? {} };
  let shaped: unknown = json;
  if (rules?.payload !== undefined) shaped = rules.payload(shaped);
  if (rules?.relay?.payload !== undefined) shaped = rules.relay.payload(shaped);
  if (isRecord(json)) shaped = withOwnStream(shaped, json);
  const headers = rules?.relay?.headers?.(shaped, incoming) ?? {};
  const text = JSON.stringify(shaped);
  return text === JSON.stringify(json) ? { body: bytes, changed: false, headers } : { body: new TextEncoder().encode(text), changed: true, headers };
};

/**
 * The relay's answer when a sign-in gave no token: its status and code (`signInRefusalOutcome`), the API's error shape with the
 * Session's text naming the sign-in, `retry-after` while the vendor's back-off holds, and the failure for t3 as SPI-1172's
 * table classes it (`sign_in_refused` signed out, `unavailable` a passing failure).
 */
export const signInRefusal = (endpointId: string, refusal: RelaySignInRefusal, now: number): { readonly response: Response; readonly failure: DescribedFailure } => {
  const { message } = credentialFailure({ id: endpointId, auth: refusal.kind }, { apiKey: null, signedOut: refusal.signedOut, problem: refusal.problem });
  const { status, code } = signInRefusalOutcome(refusal);
  const failure: DescribedFailure = { ...modelFailureOf(code), message };
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (!refusal.signedOut && refusal.retryAt !== undefined && refusal.retryAt > now) headers["retry-after"] = String(Math.ceil((refusal.retryAt - now) / 1000));
  return { response: new Response(relayErrorBody(refusal.api, status, `t3flare: ${message}`), { status, headers }), failure };
};

/** A log-only hash prefix of a sign-in's token: the first 8 hex digits of its SHA-256 (of a long random token only). */
export const tokenLogHashPrefix = async (token: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))]
    .slice(0, 4)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
