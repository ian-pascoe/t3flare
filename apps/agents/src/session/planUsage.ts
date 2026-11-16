// ChatGPT plan usage's request rules (SPI-1164), as OpenAI's "Preview limitations" page states them for
// `POST https://api.openai.com/v1/responses` with a "Sign in with ChatGPT" token: `store: false` and `stream: true` on
// every request; no `system` message items (instructions or developer messages instead); and a list of fields it
// refuses. pi-ai 1.5.0 drops some of these itself, but only for a provider named `openai` (`isChatGPTSignIn`), and a
// Model endpoint's provider is its own id, so a sign-in endpoint's requests pass through this instead (`onPayload`).

/** The request fields plan usage refuses (OpenAI's list), plus `prompt_cache_options`, which pi-ai drops for it too. */
export const PLAN_USAGE_REFUSED_FIELDS: ReadonlyArray<string> = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "prompt_cache_options",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A Responses request body as plan usage takes it; anything that is not an object is left as it is. */
export const planUsagePayload = (params: unknown): unknown => {
  if (!isRecord(params)) return params;
  const body: Record<string, unknown> = { ...params, store: false, stream: true };
  for (const field of PLAN_USAGE_REFUSED_FIELDS) delete body[field];
  if (Array.isArray(body.input)) {
    body.input = body.input.map((item: unknown) => (isRecord(item) && item.role === "system" && (item.type === undefined || item.type === "message") ? { ...item, role: "developer" } : item));
  }
  return body;
};
