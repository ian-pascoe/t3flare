// Adapted from ian-pascoe/pi-extensions@a5e15d1:packages/pi-guardian (SPI-1058; parity row pi-guardian),
// `guardian-gate.ts` in particular: the Guardian, a reviewer model that judges risky tool calls before they run. cloudpid
// has no port (its v2 list names it "needing an approval primitive in the UI"); t3's own approvals stay what they are,
// and the Guardian sits beside them: a pi-durable `beforeTool` hook, so it runs before any approval card is raised
// (`permissions.ts` wraps the tools inside the call), and it sees code mode's nested calls too (`call.parent`).
//
// Per call: the Tool Policy (`guardian/policy.ts`) allows, denies (a `deny` Command Rule or Tool Policy, no model call),
// or sends it to a Guardian Review (`guardian/review.ts`): the built-in policy and the owner's Security Policy as the
// system prompt (`guardian/prompt.ts`), reasoning-blind evidence and the Reviewed Call (`guardian/evidence.ts`), the
// Decision Table, and an Escalation Pass before a Rejection stands. A Rejection or a Review Failure blocks the call: the
// agent gets pi-guardian's rejection text, and the Session records a `t3flare.guardian` entry (never sent to the model)
// that t3 shows as a "Guardian blocked …" notice with the reason. A review's result is memoized for the call, so a
// restart does not ask again.
//
// Not ported: the interactive Allow once (t3's approvals are the owner's interactive gate), the classifier First Pass,
// pre-reviews of a response's parallel calls, the Rejection Streak, User Overrides and delegations (there are no Child
// Agents in a Durable Session).
// @effect-diagnostics asyncFunction:off globalConsole:off
import type { Context as ChordContext } from "@earendil-works/chord";
import type { Api, Model } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, type Harness, hook, type HookApi, type JsonObject, type ToolHookCall, ToolTask } from "@earendil-works/pi-durable";

import { type Assessment, rejectionReason, riskLabel, statedRationale, validRiskCategories } from "./guardian/assessment.ts";
import { renderReviewedCall, selectEvidence, toolCallsOf } from "./guardian/evidence.ts";
import { parseEntries, type PolicyEntries, readOnlyBuiltIns, resolveToolPolicy, REPO } from "./guardian/policy.ts";
import { escalationInstruction, guardianSystemPrompt } from "./guardian/prompt.ts";
import { type GuardianThinkingLevel, type ReviewResult, runGuardianReview, withEscalation } from "./guardian/review.ts";

export const GUARDIAN_EXTENSION = "guardian";
/** A Guardian's audit entry: data only, so the model never sees it; t3 shows a rejection or failure as a notice. */
export const GUARDIAN_ENTRY = "t3flare.guardian";
/** pi-guardian's `reviewTimeoutMs` default. */
export const REVIEW_TIMEOUT_MS = 60_000;

export interface GuardianSettings {
  /** The Guardian model's id among the Session's proxy models (`anthropic` provider). */
  readonly model: string;
  readonly thinkingLevel: GuardianThinkingLevel;
  /** The panel's texts: `name=allow|review|deny, …`. */
  readonly tools: string;
  readonly commands: string;
  readonly policy: string;
}

export interface GuardianHost {
  readonly harness: () => Promise<Harness>;
  /** Whether the thread is the owner's own work; a linked thread's messages come from another agent and are untrusted. */
  readonly trustUser: () => boolean;
  /** t3's `/w/<id>` paths as the Workspace's (`permissions.ts` `toToolPath`), for judging paths and commands. */
  readonly toToolPath: (text: string) => string;
  /** Whether a tool only reads and reaches nothing outside: an MCP read tool, a read-only t3 tool; undefined: unknown. */
  readonly readOnly: (toolName: string) => boolean | undefined;
  readonly sessionId: () => string;
}

const translated = (input: Readonly<Record<string, unknown>>, toToolPath: (text: string) => string): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(input).map(([key, value]) => [key, (key === "path" || key === "command" || key === "cwd") && typeof value === "string" ? toToolPath(value) : value]));

/** What a review decided, as memoized and audited. */
type Decision =
  | { readonly result: "allowed" }
  | { readonly result: "rejected" | "failed" | "denied" | "aborted"; readonly reason: string; readonly shown?: string; readonly model?: string };

/** What t3 shows of a Rejection: the risk, the authorization and the rationale. */
const shownOf = (assessment: Assessment): string => `Risk: ${riskLabel(assessment)}. Authorization: ${assessment.authorization}.\nReason: ${statedRationale(assessment)}`;

const decisionOf = (review: ReviewResult): Decision => {
  if (review.kind === "assessed") {
    return review.outcome === "allowed" ? { result: "allowed" } : { result: "rejected", reason: rejectionReason(review.assessment), shown: shownOf(review.assessment), model: review.model };
  }
  if (review.kind === "aborted") return { result: "aborted", reason: "The Guardian Review was aborted, so the call did not run." };
  return {
    result: "failed",
    reason: `The Guardian could not review this call (${review.failure}), so it did not run. A Review Failure never allows a call. Tell the owner; they can change the Guardian's model or its Tool Policies in the Harness panel.`,
    model: review.model,
  };
};

/** The response holding `callId` (a nested call's: its issuing call's), its other calls and the issuing call. */
const callContext = async (api: Pick<HookApi, "entries">, call: ToolHookCall, context: ChordContext) => {
  const own = call.parent?.callId ?? call.id;
  let cursor: unknown;
  for (let read = 0; read < 1_000; ) {
    const page = await api.entries({ order: "descending" }, 100, cursor as never, context);
    for (const entry of page.items) {
      const calls = toolCallsOf(entry);
      const found = calls.find((candidate) => candidate.id === own);
      if (found !== undefined) {
        return {
          skip: new Set(calls.map((candidate) => candidate.id)),
          batch: calls.filter((candidate) => candidate.id !== own),
          parent: call.parent === undefined ? undefined : { toolName: found.name, input: found.arguments },
        };
      }
    }
    read += page.items.length;
    cursor = page.next;
    if (cursor === undefined) break;
  }
  return { skip: new Set<string>(), batch: [], parent: undefined };
};

/** The Guardian model among the Session's models: the proxy's (`anthropic`), or any provider's model of that id. */
const guardianModel = (api: HookApi, id: string): Model<Api> | undefined => api.models.getModel("anthropic", id) ?? api.models.getModels().find((model) => model.id === id);

/** One Guardian Review of `call` and its Escalation Pass (guardian-gate.ts `review`). */
const review = async (api: HookApi, call: ToolHookCall, settings: GuardianSettings, host: GuardianHost, reason: string | undefined, securityPolicy: boolean, context: ChordContext): Promise<Decision> => {
  const model = guardianModel(api, settings.model);
  const categories = validRiskCategories(securityPolicy);
  if (model === undefined) return decisionOf({ kind: "failed", failure: `Guardian model ${settings.model} was not found`, model: settings.model, durationMs: 0, tokens: 0, cost: null });
  const where = await callContext(api, call, context);
  const evidence = await selectEvidence(api, context, { trustUser: host.trustUser(), skipCalls: where.skip });
  const reviewed = await renderReviewedCall({ toolName: call.name, input: call.arguments, cwd: REPO, reason, parent: where.parent, batch: where.batch });
  const blocks = [...evidence, reviewed].map((text) => ({ type: "text" as const, text }));
  const systemPrompt = guardianSystemPrompt(settings.policy, false, [...categories]);
  const base = { models: api.models, model, timeoutMs: REVIEW_TIMEOUT_MS, signal: context.abortSignal, sessionId: host.sessionId(), categories };
  const first = await runGuardianReview({ ...base, thinkingLevel: settings.thinkingLevel, context: { systemPrompt, messages: [{ role: "user", content: blocks, timestamp: 0 }] } });
  if (first.kind !== "assessed" || first.outcome === "allowed") return decisionOf(first);
  // A would-be Rejection: the Escalation Pass reasons carefully before it stands, at `low` thinking or above.
  const escalation = await runGuardianReview({
    ...base,
    thinkingLevel: settings.thinkingLevel === "off" ? "low" : settings.thinkingLevel,
    reasoned: true,
    context: { systemPrompt, messages: [{ role: "user", content: [...blocks, { type: "text", text: escalationInstruction([...categories]) }], timestamp: 0 }] },
  });
  return decisionOf(withEscalation(first, escalation));
};

/** Records a blocked call in the conversation, for t3 (a notice) and for the owner's audit; never for the model. */
const audit = async (host: GuardianHost, api: HookApi, call: ToolHookCall, decision: Decision, context: ChordContext): Promise<void> => {
  if (decision.result === "allowed") return;
  try {
    const conversation = await (await host.harness()).conversation(api.conversationId, context);
    const data: JsonObject = {
      tool: call.name,
      callId: call.id,
      result: decision.result,
      reason: decision.shown ?? decision.reason,
      ...(decision.model === undefined ? {} : { model: decision.model }),
      ...(call.parent === undefined ? {} : { parentCallId: call.parent.callId }),
    };
    await conversation?.submit({ type: "write", entry: { kind: GUARDIAN_ENTRY, data } }, context);
  } catch (error) {
    console.warn(JSON.stringify({ t3flare: "guardian-audit-failed", error: String(error).slice(0, 200) }));
  }
};

export const guardianExtension = (host: GuardianHost, settings: GuardianSettings): Extension => {
  const tools = parseEntries(settings.tools);
  const commands = parseEntries(settings.commands);
  const invalid = [...tools.errors, ...commands.errors];
  const securityPolicy = settings.policy.trim() !== "" || Object.values(commands.entries).includes("deny");
  return defineExtension({
    name: GUARDIAN_EXTENSION,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          // Invalid settings may have held `deny` rules: every call but the read-only built-ins fails closed.
          if (invalid.length > 0) {
            if (readOnlyBuiltIns.includes(call.name)) return undefined;
            const decision: Decision = { result: "failed", reason: `The Guardian's settings cannot be read (${invalid.map((pair) => JSON.stringify(pair)).join(", ")} is not name=allow|review|deny), so no call but a read runs until the owner fixes them in the Harness panel.` };
            await audit(host, api, call, decision, context);
            return { block: decision.reason };
          }
          const input = translated(call.arguments, host.toToolPath);
          const policy = resolveToolPolicy({ toolName: call.name, input, configured: tools.entries as PolicyEntries, commands: commands.entries as PolicyEntries, readOnly: host.readOnly(call.name) });
          if (policy.policy === "allow") return undefined;
          let decision: Decision;
          if (policy.policy === "deny") {
            decision = { result: "denied", reason: `Blocked by the owner's Guardian settings: ${policy.detail ?? `the Tool Policy for ${call.name} is deny`}. Do not try to reach the same effect another way.` };
          } else {
            // A rerun after a restart takes the decision already made, instead of asking the model again.
            const memo = `guardian:${call.id}`;
            const known = await api.memo<Decision>(memo, context);
            decision = known ?? (await api.memo<Decision>(memo, await review(api, call, settings, host, policy.detail, securityPolicy, context), context));
          }
          console.log(JSON.stringify({ t3flare: "guardian-decision", tool: call.name, policy: policy.policy, source: policy.source, result: decision.result }));
          if (decision.result === "allowed") return undefined;
          await audit(host, api, call, decision, context);
          return { block: decision.reason };
        },
      }),
    ],
  });
};

