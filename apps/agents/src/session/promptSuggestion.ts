// Prompt suggestions (SPI-996, parity G5): t3's labs flag `promptSuggestionsEnabled` asks a provider for the owner's
// likely next message after a completed turn (`prompt_suggestion.updated`). t3's Codex adapter samples its own thread
// with `CODEX_PROMPT_SUGGESTION_PROMPT` at low effort (t3code `CodexAdapterV2.ts`, `samplePromptSuggestion`); Claude
// Code makes its own. A Durable agent has neither, so the Session asks a small model through the proxy, with the turn's
// request and answer only (bounded), never the whole thread: one cheap request per completed turn, only while the owner
// has the labs flag on.
// @effect-diagnostics asyncFunction:off globalTimers:off
import type { Api, Context, Model, Models } from "@earendil-works/pi-ai";

/** t3's prompt (`CODEX_PROMPT_SUGGESTION_PROMPT`, t3code `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`). */
export const PROMPT_SUGGESTION_PROMPT =
  "Predict the next message the user will send in this conversation. Reply with only that message, written as the user would type it, in under 20 words. Do not use tools. If there is no clear next step, reply with nothing.";

/** The model that predicts: small and fast, as the Guardian's default. */
export const SUGGESTION_MODEL = "claude-haiku-5-5";
/** Most characters of the request and of the answer the model reads. */
export const SUGGESTION_EXCERPT = 4_000;
export const SUGGESTION_TIMEOUT_MS = 20_000;
/** Most characters of a suggestion t3 is given. */
const MAX_SUGGESTION = 300;

const excerpt = (text: string): string => (text.length <= SUGGESTION_EXCERPT ? text : `…${text.slice(-SUGGESTION_EXCERPT)}`);

/** The request the model answers: the turn's user message and the agent's answer, then t3's prompt. */
export const suggestionContext = (user: string, answer: string): Context => ({
  systemPrompt: "You predict what a developer will type next to their coding agent.",
  messages: [
    {
      role: "user",
      content: `The developer wrote:\n<message>\n${excerpt(user)}\n</message>\n\nThe agent answered:\n<answer>\n${excerpt(answer)}\n</answer>\n\n${PROMPT_SUGGESTION_PROMPT}`,
      timestamp: 0,
    },
  ],
});

/** The suggestion, or "" when the model has none or fails (best effort, as t3's adapters treat it). */
export const suggestPrompt = async (models: Pick<Models, "completeSimple">, model: Model<Api>, user: string, answer: string): Promise<string> => {
  if (user.trim() === "" || answer.trim() === "") return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("prompt suggestion timed out")), SUGGESTION_TIMEOUT_MS);
  try {
    const reply = await models.completeSimple(model, suggestionContext(user, answer), { signal: controller.signal });
    if (reply.stopReason === "error" || reply.stopReason === "aborted") return "";
    const text = reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
    return text.length > MAX_SUGGESTION ? "" : text.replace(/^["']|["']$/g, "").trim();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
};
