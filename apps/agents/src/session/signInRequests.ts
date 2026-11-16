// What a sign-in's requests need beyond its token (SPI-1164), by kind: the one table a Session's pi-ai requests and the
// model relay's CLI requests (SPI-1171) both apply. A new sign-in adds its entry here.
//
// - `payload`: the request body's rules, on both paths (the Session's `onPayload`; the relay on the CLI's JSON body).
// - `compat`, `headers`: the Session's pi-ai models' overrides and its per-context headers.
// - `relay`: what pi-ai does for a Session from the token or a provider id of its own, which a CLI's request on the relay
//   lacks (the CLI sends an API key's shape with its model handle), restated for the relay: headers from the request's
//   body and the headers the CLI sent, and a body rule of its own.
//
// - ChatGPT plan usage: no `configuration_update` items, so the effort goes as `reasoning.effort`; no Responses
//   `tool_search`; OpenAI's refused fields left out (planUsage.ts).
// - Claude (SPI-1165): nothing of ours in a Session: pi-ai gives a Claude subscription's token (`sk-ant-oat…`) Claude
//   Code's request shape itself (Bearer auth, its betas, user agent and identity block, and its tool names;
//   anthropic-messages.js `isOAuthToken`; `claudeSignInShape.test.ts` pins it; an API key never takes it). On the relay
//   the betas, headers and identity block are added (claudeSignIn.ts); the tool names are the CLI's own.
// - GitHub Copilot (SPI-1166): what pi-ai does for its own `github-copilot` provider, which a sign-in endpoint is not
//   (copilot.ts): the dynamic headers per request, and no thinking-off `reasoning`. Its base URL and editor headers are
//   its token's, from the Credential broker.
import type { Context, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import type { SignIn } from "@t3flare/models/endpoints";

import { claudeRelayHeaders, claudeRelayPayload } from "./claudeSignIn.ts";
import { copilotHeaders, copilotPayload, copilotRelayHeaders } from "./copilot.ts";
import { PLAN_USAGE_COMPAT, planUsagePayload } from "./planUsage.ts";

export interface SignInRequests {
  /** The request body's rules, on a Session's requests and the relay's. */
  readonly payload?: (params: unknown) => unknown;
  /** The Session's pi-ai models' compatibility overrides. */
  readonly compat?: OpenAIResponsesCompat;
  /** Headers for a Session's request context, beside the auth's. */
  readonly headers?: (context: Context) => Record<string, string>;
  /** The relay's own rules for a CLI's request, after `payload`. */
  readonly relay?: {
    /** Headers from the request's JSON body (after the body's rules; undefined when it has none) and the CLI's headers. */
    readonly headers?: (body: unknown, incoming: Headers) => Record<string, string>;
    readonly payload?: (body: unknown) => unknown;
  };
}

export const SIGN_IN_REQUESTS: Readonly<Partial<Record<SignIn, SignInRequests>>> = {
  chatgpt: { payload: planUsagePayload, compat: PLAN_USAGE_COMPAT },
  claude: { relay: { headers: claudeRelayHeaders, payload: claudeRelayPayload } },
  copilot: { payload: copilotPayload, headers: copilotHeaders, relay: { headers: copilotRelayHeaders } },
};
