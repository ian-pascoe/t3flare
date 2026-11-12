// @effect-diagnostics globalConsole:off globalConsoleInEffect:off globalJsonInEffect:off globalDate:off effectFnOpportunity:off anyUnknownInErrorContext:off
// What the Cloud Environment's ACP flavors share (step 4b, plan §3.2 and §5 with the review's F1, F7, F9; back to stock,
// owner 2026-11-12): the agent is pinned to its asking mode and t3 decides each request it asks, as stock t3's adapters
// decide (plan §5.1); this module is that decision, the model ids, the proxy's failures, and the plan capture around the
// runtime both CLIs run under.
//
// - `cliPermissionDisposition`: t3's own rules for its modes. Reads never ask; `auto-accept-edits` allows every edit
//   (t3's `acpPermissionDisposition` without a sandbox policy); `full-access` allows; `approval-required`, `auto` and an
//   unknown mode ask. A plan turn denies every edit and the agent's own request to leave plan mode (review F1).
// - `cliSessionModeForPolicy`: the pinned asking mode, or Claude's own `auto` for t3's `auto` (as stock t3's Claude
//   adapter maps it); OpenCode has no auto mode and asks, as stock t3's OpenCode adapter does.
// - `guardedRuntime`: the runtime t3's adapter drives, wrapped so Claude's `ExitPlanMode` plan becomes t3's proposed plan
//   when it is asked (F1), and so `auto` falls back to the asking mode when Claude does not offer it.
// The approval card is t3's own ("for the session" included); an agent changing its own mode is its business, as in
// stock t3.
import type { OrchestrationV2ProviderFailure, RuntimeMode } from "@t3tools/contracts";
import { classifyProxyFailure, proxyFailureMessage, type ProxyFailure } from "@t3flare/models/proxyFailure";
import type { AcpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpErrors from "effect-acp/errors";

export type AcpCli = "claude" | "opencode";

/** The asking mode each agent is pinned to (plan §5.1). */
export const PINNED_MODE: Readonly<Record<AcpCli, string>> = { claude: "default", opencode: "build" };

/** Claude's own auto mode, selected for t3's `auto` (stock t3's Claude adapter: `permissionModeForClaudeRuntimePolicy`). */
export const CLAUDE_AUTO_MODE = "auto";

/** t3's read kinds (`clientPolicy.ts` `isAcpReadKind`): they never ask. */
const READ_KINDS: ReadonlySet<string> = new Set(["read", "search", "think"]);
const EDIT_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"]);

/**
 * t3's answer to a permission request the pinned agent asks: allow it without asking the owner, ask the owner, or deny
 * it. Reads never ask (t3's rule); a plan turn denies edits and leaving plan mode, and asks for the rest.
 */
export const cliPermissionDisposition = (
  policy: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "runtimeMode" | "interactionMode" | "cwd">,
  request: Pick<EffectAcpSchema.RequestPermissionRequest, "toolCall">,
): AcpPermissionDisposition => {
  const kind = request.toolCall.kind ?? "other";
  if (READ_KINDS.has(kind)) return "allow";
  if (policy.interactionMode === "plan") return EDIT_KINDS.has(kind) || kind === "switch_mode" ? "deny" : "ask";
  if (policy.runtimeMode === "full-access") return "allow";
  if (policy.runtimeMode === "auto-accept-edits" && EDIT_KINDS.has(kind)) return "allow";
  return "ask";
};

/** The session mode for t3's runtime policy: Claude's `auto` for t3's `auto` outside a plan turn, else the asking mode. */
export const cliSessionModeForPolicy =
  (cli: AcpCli) =>
  (policy: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "runtimeMode" | "interactionMode">): string =>
    cli === "claude" && policy.runtimeMode === "auto" && policy.interactionMode !== "plan" ? CLAUDE_AUTO_MODE : PINNED_MODE[cli];

/** The runtime mode an agent's own mode grants: its asking and plan modes ask, Claude's auto is t3's auto; any other is never applied. */
export const cliRuntimeModeForSessionMode =
  (cli: AcpCli) =>
  (modeId: string): RuntimeMode | undefined =>
    modeId === PINNED_MODE[cli] || modeId === "plan" ? "approval-required" : cli === "claude" && modeId === CLAUDE_AUTO_MODE ? "auto" : undefined;

/** The catalog id of a model slug (`anthropic/<id>`), as each CLI names it. */
export const cliModelId = (cli: AcpCli, slug: string): string => {
  const id = slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug;
  return cli === "opencode" ? `t3flare/${id}` : id;
};

/** The model proxy's status and body inside an ACP error's text (`… API Error: 429 {…}`), as pi-ai writes them. */
const proxyAnswerText = (text: string): string | undefined => {
  const match = /API Error:\s*([45]\d\d)\b\s*([\s\S]*)$/i.exec(text) ?? /\bstatus(?: code)?:?\s*([45]\d\d)\b\s*([\s\S]*)$/i.exec(text);
  return match === null ? undefined : `${match[1]} ${match[2] ?? ""}`.trim();
};

const isAcpRequestError = (cause: unknown): cause is EffectAcpErrors.AcpRequestError =>
  typeof cause === "object" && cause !== null && (cause as { _tag?: unknown })._tag === "AcpRequestError";

const errorText = (cause: unknown): string => {
  if (isAcpRequestError(cause)) return `${cause.errorMessage}${cause.data === undefined ? "" : ` ${JSON.stringify(cause.data)}`}`;
  return cause instanceof Error ? cause.message : String(cause);
};

/** The key the CLIs use: named when the proxy refuses it, never a vendor sign-in (ADR-0016). */
export const KEY_NAME = "COMMISSARY_CONTAINER_API_KEY";

/**
 * A prompt's failure (review F9): the proxy's own answers classified as the Durable agents' are (a 429 is t3's usage
 * limit, with its reset), a refused key named as the deploy's key, never as a sign-in. Anything else is the provider's.
 */
export const cliPromptFailure = (cause: unknown, now = Date.now()): OrchestrationV2ProviderFailure => {
  const text = errorText(cause);
  const answer = proxyAnswerText(text);
  const classified: ProxyFailure | undefined = answer === undefined ? undefined : classifyProxyFailure({ status: 0, retryAfter: null, text: answer, at: now });
  const code = isAcpRequestError(cause) ? String(cause.code) : null;
  if (classified !== undefined) {
    const resetAt =
      classified.class === "usage_limit" && classified.resetAt !== undefined ? DateTime.formatIso(DateTime.makeUnsafe(Math.max(classified.resetAt, now + 60_000))) : null;
    return makeProviderFailure({
      cause,
      class: classified.class,
      message: classified.class === "permission_error" ? `${proxyFailureMessage(classified)} Check the deploy's ${KEY_NAME}.` : proxyFailureMessage(classified),
      code: classified.code,
      retryable: classified.class !== "permission_error",
      resetAt,
    });
  }
  if (/auth(entication)?[_ ]required|not (logged|signed) in|\/login|invalid api key|\b401\b/i.test(text)) {
    return makeProviderFailure({
      cause,
      class: "permission_error",
      message: `The model proxy refused the agent's key. Check the deploy's ${KEY_NAME}; this agent never signs in to a vendor.`,
      code,
      retryable: false,
    });
  }
  return makeProviderFailure({ cause, class: "provider_error", ...(code === null ? {} : { code }) });
};

/** Claude's `ExitPlanMode` request: its plan, when the request carries one. */
export const exitPlanMarkdown = (request: Pick<EffectAcpSchema.RequestPermissionRequest, "toolCall">): string | undefined => {
  if (request.toolCall.kind !== "switch_mode") return undefined;
  const raw = request.toolCall.rawInput;
  const plan = typeof raw === "object" && raw !== null && "plan" in raw ? (raw as { plan?: unknown }).plan : undefined;
  return typeof plan === "string" && plan.trim().length > 0 ? plan.trim() : undefined;
};

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];

/**
 * Review F1: denying ExitPlanMode stops Claude's turn (ACP v2: an `idle` whose stop reason is `cancelled` or, after its
 * interrupted query, `error`). When we captured the plan in that turn, the turn ended with its plan: `end_turn`.
 */
const planTurnEnd = (slot: GuardSlot, notification: EffectAcpSchema.SessionNotification): EffectAcpSchema.SessionNotification => {
  const update = notification.update as { sessionUpdate: string; state?: string; stopReason?: string };
  if (!slot.planCaptured || update.sessionUpdate !== "state_update" || update.state !== "idle" || (update.stopReason !== "cancelled" && update.stopReason !== "error")) return notification;
  slot.planCaptured = false;
  const { error: _error, ...rest } = notification.update as unknown as Record<string, unknown>;
  return { ...notification, update: { ...rest, stopReason: "end_turn" } as unknown as EffectAcpSchema.SessionNotification["update"] };
};

/** What `registerExtensions` gives the runtime it wraps: t3's proposed-plan capture. */
export interface GuardSlot {
  capture: ((input: { readonly planMarkdown: string }) => Effect.Effect<void>) | undefined;
  /** A plan was handed to t3 during the running prompt: Claude's stop after the denied ExitPlanMode is the plan's end. */
  planCaptured: boolean;
}

/** The slot of each runtime this module wrapped, for the flavor's `registerExtensions`. */
export const guardSlots = new WeakMap<object, GuardSlot>();

/**
 * The runtime t3's adapter drives, wrapped:
 * - Claude's `ExitPlanMode` request in plan mode hands its plan to t3 (review F1) before t3's handler denies it, and the
 *   prompt Claude then stops as cancelled ends with its plan;
 * - `setMode` to Claude's auto mode falls back to the asking mode when the agent does not offer auto (t3's nearest).
 */
export const guardedRuntime = (cli: AcpCli, runtime: Runtime): Runtime => {
  const slot: GuardSlot = { capture: undefined, planCaptured: false };
  // ACP v1 reports the mode as a session mode; v2 as the `mode` config option.
  const inPlanMode = Effect.gen(function* () {
    if ((yield* runtime.getModeState)?.currentModeId === "plan") return true;
    const mode = (yield* runtime.getConfigOptions).find((option) => option.id === "mode");
    return mode?.type === "select" && mode.currentValue === "plan";
  });
  const offersMode = (modeId: string) =>
    Effect.gen(function* () {
      if ((yield* runtime.getModeState)?.availableModes.some((mode) => mode.id === modeId) === true) return true;
      const mode = (yield* runtime.getConfigOptions).find((option) => option.id === "mode");
      return mode?.type === "select" && mode.options.some((entry) => ("value" in entry ? entry.value === modeId : entry.options.some((choice) => choice.value === modeId)));
    });
  const wrapped: Runtime = {
    ...runtime,
    setMode: (modeId) =>
      Effect.gen(function* () {
        if (modeId !== CLAUDE_AUTO_MODE || (yield* offersMode(modeId))) return yield* runtime.setMode(modeId);
        console.warn(JSON.stringify({ t3flare: "acp-auto-unavailable", cli, fallback: PINNED_MODE[cli] }));
        return yield* runtime.setMode(PINNED_MODE[cli]);
      }),
    prompt: (payload, options) =>
      Effect.gen(function* () {
        slot.planCaptured = false;
        const result = yield* runtime.prompt(payload, options);
        // Review F1: denying ExitPlanMode makes Claude stop the prompt as cancelled; the plan turn ended with its plan.
        return slot.planCaptured && result.stopReason === "cancelled" ? { ...result, stopReason: "end_turn" as const } : result;
      }),
    handleSessionUpdate: (handler) => runtime.handleSessionUpdate((notification) => handler(planTurnEnd(slot, notification))),
    handleRequestPermission: (handler) =>
      runtime.handleRequestPermission((params, context) =>
        Effect.gen(function* () {
          const plan = cli === "claude" ? exitPlanMarkdown(params) : undefined;
          if (plan !== undefined && slot.capture !== undefined && (yield* inPlanMode)) {
            yield* slot.capture({ planMarkdown: plan });
            slot.planCaptured = true;
          }
          return yield* handler(params, context);
        }),
      ),
  };
  guardSlots.set(wrapped, slot);
  return wrapped;
};
