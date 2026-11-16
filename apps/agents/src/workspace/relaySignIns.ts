// A sign-in endpoint on the model relay (SPI-1171). The Environment gives the relay a sign-in's target per request: the
// Credential broker's access token, asked for at that request (renewed first when near its expiry, so a token renewed
// mid-thread is the next request's), as a bearer, at the base URL the sign-in's kind allows (`signInRequestTarget`, the
// Session's rule). This adds what the sign-in's requests need beyond the token, from the Session's own table
// (`SIGN_IN_REQUESTS`): the body's rules (ChatGPT plan usage's, Copilot's) on the CLI's JSON body, then the relay's own
// headers and body rule (Claude's betas, headers and identity block; Copilot's dynamic headers). A body that is no JSON,
// or that the rules leave as it was, goes on byte for byte.
//
// When the broker gives no token (signed out, its renewal refused, or a passing failure), the CLI gets an error in its
// API's own shape whose message names the sign-in, and the process's last answer is that failure, classified, so t3
// shows it (`modelRelayOutcome`, SPI-1172). A passing failure carries `retry-after` when the vendor named when a renewal
// may be tried again (`earliestRefreshAt`), so a CLI's retries wait for it rather than spin.
import type { SignIn } from "@t3flare/models/endpoints";
import type { DescribedFailure } from "@t3flare/models/failures";
import type { RelaySignInRefusal } from "@t3flare/models/relay";

import { credentialFailure } from "../session/credentialFailure.ts";
import { SIGN_IN_REQUESTS } from "../session/signInRequests.ts";
import { relayErrorBody } from "./relayFailures.ts";

const parsed = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
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
  const headers = rules?.relay?.headers?.(shaped, incoming) ?? {};
  const text = JSON.stringify(shaped);
  return text === JSON.stringify(json) ? { body: bytes, changed: false, headers } : { body: new TextEncoder().encode(text), changed: true, headers };
};

/**
 * The relay's answer when a sign-in gave no token: the status (401 signed out, 503 a passing failure), the API's error
 * shape with the Session's text naming the sign-in, `retry-after` when known, and the failure as the process's last answer.
 */
export const signInRefusal = (endpointId: string, refusal: RelaySignInRefusal, now: number): { readonly response: Response; readonly failure: DescribedFailure } => {
  const { message } = credentialFailure({ id: endpointId, auth: refusal.kind }, { apiKey: null, signedOut: refusal.signedOut, problem: refusal.problem });
  const status = refusal.signedOut ? 401 : 503;
  const failure: DescribedFailure = refusal.signedOut
    ? { class: "permission_error", code: "sign_in_refused", retryable: false, stop: true, message }
    : { class: "provider_error", code: "unavailable", retryable: true, stop: false, message };
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (!refusal.signedOut && refusal.retryAt !== undefined && refusal.retryAt > now) headers["retry-after"] = String(Math.ceil((refusal.retryAt - now) / 1000));
  return { response: new Response(relayErrorBody(refusal.api, status, `t3flare: ${message}`), { status, headers }), failure };
};
