// A GitHub Copilot sign-in's request rules (SPI-1166): what pi-ai 1.5.0 does for a model whose provider is
// `github-copilot`, restated for a Copilot sign-in endpoint, whose provider is its own id (as U77 says of plan usage).
// - Its dynamic headers (`api/openai-responses.js` :210-217, pi-ai's own `buildCopilotDynamicHeaders`): `X-Initiator`
//   (`user` when the last message is the owner's, else `agent`), `Openai-Intent: conversation-edits`, and
//   `Copilot-Vision-Request` with an image.
// - No `reasoning` with the thinking level off (`api/openai-responses.js` :297: pi-ai sends the model's "off" effort to
//   every other provider). With the level on, `reasoning` carries a `summary`; off, it carries only the effort.
// The editor headers and the base URL are the token's, from the Credential broker (`EndpointCredential`), never here.
// `copilotSignInShape.test.ts` pins the wire. docs/upstream-fragility.md U82.
import type { Context } from "@earendil-works/pi-ai";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "@earendil-works/pi-ai/api/github-copilot-headers";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The headers pi-ai adds to a Copilot request for this context. */
export const copilotHeaders = (context: Context): Record<string, string> =>
  buildCopilotDynamicHeaders({ messages: context.messages, hasImages: hasCopilotVisionInput(context.messages) });

/**
 * A Responses `input` item as pi-ai's message roles read it: the owner's message is `user`; a tool's output `toolResult`
 * (its images count as vision input, as a tool result's do); anything else the agent's.
 */
const messageOf = (item: unknown): { readonly role: string; readonly content: ReadonlyArray<{ readonly type: string }> } => {
  if (!isRecord(item)) return { role: "assistant", content: [] };
  const parts = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord).map((part) => ({ type: part.type === "input_image" ? "image" : String(part.type) })) : []);
  if (item.role === "user") return { role: "user", content: parts(item.content) };
  if (item.type === "function_call_output") return { role: "toolResult", content: parts(item.output) };
  return { role: typeof item.role === "string" ? item.role : "assistant", content: [] };
};

/**
 * The headers pi-ai adds to a Copilot request, from a CLI's Responses body on the model relay (SPI-1171): its `input`
 * read as pi-ai's messages, then pi-ai's own rule (`buildCopilotDynamicHeaders`).
 */
export const copilotRelayHeaders = (body: unknown): Record<string, string> => {
  const input = isRecord(body) ? body.input : undefined;
  const messages = (typeof input === "string" ? [{ role: "user", content: [] }] : Array.isArray(input) ? input.map(messageOf) : []) as Context["messages"];
  return buildCopilotDynamicHeaders({ messages, hasImages: hasCopilotVisionInput(messages) });
};

/** A Responses body as pi-ai sends it to Copilot: no thinking-off `reasoning`. Anything not an object is left as it is. */
export const copilotPayload = (params: unknown): unknown => {
  if (!isRecord(params) || !isRecord(params.reasoning) || "summary" in params.reasoning) return params;
  const { reasoning: _off, ...body } = params;
  return body;
};
