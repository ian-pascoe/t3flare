// Adapted from ian-pascoe/pi-extensions@a5e15d1:packages/pi-guardian/src/guardian-review.ts (SPI-1058): one Guardian
// Review, a stateless completion without tools bounded by the review timeout, with one corrective retry for a malformed
// or uncategorized reply, and the Escalation Pass for a would-be Rejection. Changed: the model is reached through the
// Session's own models (the proxy, `api.models`) with `completeSimple`; there is no classifier First Pass, no cache
// breakpoint helper and no token calibration (evidence is bounded in characters, `evidence.ts`).
// @effect-diagnostics asyncFunction:off globalDate:off globalTimers:off newPromise:off
import { type Api, type AssistantMessage, clampThinkingLevel, type Context, type Model, type Models } from "@earendil-works/pi-ai";

import { type Assessment, decide, decidedRisk, type Outcome, parseAssessment, parseFinalAssessment, type RiskCategory, uncategorized } from "./assessment.ts";

export type GuardianThinkingLevel = "off" | "low" | "medium" | "high";

export interface ReviewMetrics {
  readonly model: string;
  readonly durationMs: number;
  /** Total tokens and cost summed over the review's requests; cost null when unknown. */
  readonly tokens: number;
  readonly cost: number | null;
  readonly retried?: boolean;
  /** Set when an Escalation Pass ran: the First Pass's assessment. */
  readonly escalated?: { readonly firstPass: Assessment };
}

export type ReviewResult =
  | ({ readonly kind: "assessed"; readonly assessment: Assessment; readonly outcome: Outcome } & ReviewMetrics)
  | ({ readonly kind: "failed"; readonly failure: string } & ReviewMetrics)
  | ({ readonly kind: "aborted" } & ReviewMetrics);

export interface GuardianReviewInput {
  readonly models: Pick<Models, "completeSimple">;
  readonly model: Model<Api>;
  readonly thinkingLevel: GuardianThinkingLevel;
  readonly context: Context;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly sessionId: string;
  readonly categories: ReadonlyArray<RiskCategory>;
  readonly reasoned?: boolean;
}

export const correctiveMessage =
  'Your reply did not contain exactly one valid assessment. Respond again with exactly one JSON object and nothing else: {"risk_level": "low" | "medium" | "high" | "critical", "user_authorization": "unknown" | "low" | "medium" | "high"}, adding "risk_category" and "rationale" when the output contract asks for them.';

export const categoryCorrectiveMessage = (categories: ReadonlyArray<RiskCategory>): string =>
  `Your assessment rated the risk high or critical without naming a valid Risk Category. \`high\` and \`critical\` risk require exactly one of: ${categories.join(", ")}. If one concretely applies to this exact call, respond again with exactly one JSON object naming it in "risk_category", with a "rationale"; if none applies, the risk is \`low\` or \`medium\`, so respond with that assessment instead. Respond with the JSON object and nothing else.`;

const replyText = (reply: AssistantMessage): string => reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export const modelName = (model: Pick<Model<Api>, "provider" | "id">): string => `${model.provider}/${model.id}`;

/** One Guardian Review (guardian-review.ts `runGuardianReview`). */
export const runGuardianReview = async (input: GuardianReviewInput): Promise<ReviewResult> => {
  const started = Date.now();
  const replies: Array<AssistantMessage> = [];
  const measured = () => {
    let cost: number | null = 0;
    let tokens = 0;
    for (const { usage } of replies) {
      tokens += usage.totalTokens;
      cost = cost !== null && Number.isFinite(usage.cost.total) ? cost + usage.cost.total : null;
    }
    return { model: modelName(input.model), durationMs: Date.now() - started, tokens, cost: replies.length === 0 ? null : cost, ...(replies.length > 1 ? { retried: true } : {}) };
  };
  const aborted = () => input.signal?.aborted === true;
  if (aborted()) return { kind: "aborted", ...measured() };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), input.timeoutMs);
  const signal = input.signal === undefined ? timeout.signal : AbortSignal.any([input.signal, timeout.signal]);
  const level = input.model.reasoning ? clampThinkingLevel(input.model, input.thinkingLevel) : "off";
  const assessed = (assessment: Assessment): ReviewResult => ({ kind: "assessed", assessment, outcome: decide(decidedRisk(assessment), assessment.authorization), ...measured() });
  let context = input.context;
  try {
    for (;;) {
      let reply: AssistantMessage | undefined;
      let failure: string | undefined;
      try {
        reply = await input.models.completeSimple(input.model, context, { signal, sessionId: input.sessionId, ...(level === "off" ? {} : { reasoning: level }) });
      } catch (cause) {
        failure = errorMessage(cause);
      }
      if (reply !== undefined) replies.push(reply);
      if (aborted()) return { kind: "aborted", ...measured() };
      if (timeout.signal.aborted) return { kind: "failed", failure: `Guardian Review timed out after ${input.timeoutMs / 1_000}s`, ...measured() };
      if (failure !== undefined || reply === undefined) return { kind: "failed", failure: `Guardian model request failed: ${failure ?? "no response"}`, ...measured() };
      if (reply.stopReason === "error" || reply.stopReason === "aborted") return { kind: "failed", failure: `Guardian model request failed: ${reply.errorMessage ?? reply.stopReason}`, ...measured() };
      let corrective = correctiveMessage;
      try {
        const assessment = (input.reasoned === true ? parseFinalAssessment : parseAssessment)(replyText(reply), [...input.categories]);
        if (!uncategorized(assessment) || replies.length > 1) return assessed(assessment);
        corrective = categoryCorrectiveMessage(input.categories);
      } catch (cause) {
        if (replies.length > 1) return { kind: "failed", failure: `${errorMessage(cause)}, even after a corrective retry`, ...measured() };
      }
      context = { ...input.context, messages: [...input.context.messages, reply, { role: "user", content: corrective, timestamp: 0 }] };
    }
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A First Pass with its Escalation Pass (`withEscalation`, trigger `rejected`): the second pass decides when it assessed;
 * when it failed, the First Pass's Rejection stands, so an escalation never allows by failing.
 */
export const withEscalation = (first: ReviewResult & { readonly kind: "assessed" }, pass: ReviewResult): ReviewResult => {
  const metrics = {
    model: first.model,
    durationMs: first.durationMs + pass.durationMs,
    tokens: first.tokens + pass.tokens,
    cost: first.cost === null || pass.cost === null ? (pass.tokens === 0 ? first.cost : null) : first.cost + pass.cost,
    escalated: { firstPass: first.assessment },
  };
  if (pass.kind === "aborted") return { kind: "aborted", ...metrics };
  if (pass.kind === "assessed") return { kind: "assessed", assessment: pass.assessment, outcome: pass.outcome, ...metrics };
  return { kind: "assessed", assessment: first.assessment, outcome: first.outcome, ...metrics };
};
