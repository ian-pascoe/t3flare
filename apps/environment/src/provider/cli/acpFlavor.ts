// @effect-diagnostics globalConsole:off globalConsoleInEffect:off globalJsonInEffect:off globalDate:off effectFnOpportunity:off anyUnknownInErrorContext:off
// What the Cloud Environment's ACP flavors share (step 4b, plan §3.2 and §5 with the review's F1, F2, F4, F7, F9): the
// rule that every mode fails closed. The agent is always pinned to its asking mode and t3 decides each request it asks
// (plan §5.1); this module is that decision, the approval card, the model ids, the proxy's failures, and the guard
// around the runtime both CLIs run under.
//
// - `cliPermissionDisposition`: t3's `acpPermissionDisposition` assumes a sandbox policy t3 never sets (review F2:
//   `RuntimePolicy` carries none, so `auto-accept-edits` allowed every edit wherever it pointed). Here edits are
//   contained lexically on the thread's cwd, never into `.git/`, `.claude/` or `.opencode/`; a plan turn denies every
//   edit and the agent's own request to leave plan mode (review F1); an unknown mode is `approval-required`.
// - `cliApprovalOptions`: once or reject, never the agent's "always" (Claude's saves a rule or leaves plan mode for an
//   auto mode; OpenCode's saves a durable project rule, M0 P4).
// - `guardedRuntime`: the runtime t3's adapter drives, wrapped so the session fails closed when the agent's mode is not
//   one we pinned (review F4), and so Claude's `ExitPlanMode` plan becomes t3's proposed plan when it is asked (F1).
import type { OrchestrationV2ProviderFailure, ProviderApprovalOption, RuntimeMode } from "@t3tools/contracts";
import { classifyProxyFailure, proxyFailureMessage, type ProxyFailure } from "@t3flare/models/proxyFailure";
import type { AcpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

export type AcpCli = "claude" | "opencode";

/** Directories an auto-accepted edit never reaches: git's own, and each CLI's project configuration. */
export const PROTECTED_DIRS: ReadonlyArray<string> = [".git", ".claude", ".opencode"];

/** The modes each agent may be in: its asking mode and its plan mode (review F4). */
export const ALLOWED_MODES: Readonly<Record<AcpCli, ReadonlySet<string>>> = {
  claude: new Set(["default", "plan"]),
  opencode: new Set(["build", "plan"]),
};

/** The asking mode each agent is pinned to, whatever the runtime mode (plan §5.1). */
export const PINNED_MODE: Readonly<Record<AcpCli, string>> = { claude: "default", opencode: "build" };

/** t3's read kinds (`clientPolicy.ts` `isAcpReadKind`): they never ask. */
const READ_KINDS: ReadonlySet<string> = new Set(["read", "search", "think"]);
const EDIT_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"]);
const RUNTIME_MODES: ReadonlySet<string> = new Set(["approval-required", "auto-accept-edits", "full-access"]);

/** POSIX normalisation without the file system: `.` and `..` resolved, no symlinks (the Container's are not visible). */
const normalize = (path: string): string => {
  const out: Array<string> = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
};

/** Whether every location is inside `cwd` and outside the protected directories (none named: false). */
export const editStaysInCwd = (cwd: string | null, locations: ReadonlyArray<{ readonly path: string }> | null | undefined): boolean => {
  if (cwd === null || !cwd.startsWith("/") || locations === null || locations === undefined || locations.length === 0) return false;
  const root = normalize(cwd);
  return locations.every(({ path }) => {
    const trimmed = path.trim();
    if (trimmed.length === 0) return false;
    const full = normalize(trimmed.startsWith("/") ? trimmed : `${root}/${trimmed}`);
    if (full !== root && !full.startsWith(`${root}/`)) return false;
    return !full.slice(root.length).split("/").some((segment) => PROTECTED_DIRS.includes(segment));
  });
};

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
  const mode = RUNTIME_MODES.has(policy.runtimeMode) ? policy.runtimeMode : "approval-required";
  if (mode === "full-access") return "allow";
  if (mode === "auto-accept-edits" && EDIT_KINDS.has(kind) && editStaysInCwd(policy.cwd, request.toolCall.locations)) return "allow";
  return "ask";
};

/** The approval card: cancel, reject, allow once. Never "for the session" (it would pick the agent's "always"). */
export const cliApprovalOptions = (request: Pick<EffectAcpSchema.RequestPermissionRequest, "options">): ReadonlyArray<ProviderApprovalOption> => {
  const has = (kind: EffectAcpSchema.PermissionOption["kind"]) => request.options.some((option) => option.kind === kind);
  return [
    { decision: "cancel", label: "Cancel" },
    ...(has("reject_once") ? [{ decision: "decline", label: "Reject" } as const] : []),
    ...(has("allow_once") ? [{ decision: "accept", label: "Allow once" } as const] : []),
  ];
};

/** The runtime mode an agent's own mode grants: its asking and plan modes ask; any other is never applied. */
export const cliRuntimeModeForSessionMode =
  (cli: AcpCli) =>
  (modeId: string): RuntimeMode | undefined =>
    ALLOWED_MODES[cli].has(modeId) ? "approval-required" : undefined;

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
  const detail = typeof cause === "object" && cause !== null ? (cause as { detail?: unknown }).detail : undefined;
  if (text.includes(MODE_DRIFT) || (typeof detail === "string" && detail.includes(MODE_DRIFT))) {
    return makeProviderFailure({ cause, class: "provider_error", message: "The agent left its approval mode, so t3flare ended its session. Send the message again to start a new one.", code: "mode_drift", retryable: true });
  }
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

/** The reason a session ends when its agent is not in a mode we pinned. */
export const MODE_DRIFT = "t3flare: the agent left its approval mode; the session was ended";

/** The modes an agent may offer: its asking modes, Claude's `acceptEdits` (never applied: no runtime mode grants it), plan. */
const OFFERABLE_MODES: ReadonlySet<string> = new Set(["default", "acceptEdits", "plan", "build"]);

/**
 * Why the agent's advertised modes cannot be trusted (review F4: `claude-agent-acp` starts in `auto` when the managed
 * policy is not read), or undefined when they can: the current mode is an allowed one and no mode that skips asking is
 * offered. OpenCode has no ACP modes; its agent is a config option, checked by `configModeProblem`.
 */
export const modeStateProblem = (cli: AcpCli, modes: AcpSessionModeState | undefined): string | undefined => {
  if (modes === undefined) return cli === "claude" ? "the agent advertised no modes" : undefined;
  const skipping = modes.availableModes.map((mode) => mode.id).filter((id) => !OFFERABLE_MODES.has(id));
  if (skipping.length > 0) return `the agent offers modes that skip asking (${skipping.join(", ")})`;
  if (!ALLOWED_MODES[cli].has(modes.currentModeId)) return `the agent is in mode ${modes.currentModeId}`;
  return undefined;
};

/** OpenCode's agent (its `mode` config option) must be one we pinned. */
export const configModeProblem = (cli: AcpCli, options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>): string | undefined => {
  const mode = options.find((option) => option.id === "mode");
  if (mode === undefined || mode.type !== "select" || typeof mode.currentValue !== "string") return undefined;
  return ALLOWED_MODES[cli].has(mode.currentValue) ? undefined : `the agent runs as ${mode.currentValue}`;
};

/** Claude's `ExitPlanMode` request: its plan, when the request carries one. */
export const exitPlanMarkdown = (request: Pick<EffectAcpSchema.RequestPermissionRequest, "toolCall">): string | undefined => {
  if (request.toolCall.kind !== "switch_mode") return undefined;
  const raw = request.toolCall.rawInput;
  const plan = typeof raw === "object" && raw !== null && "plan" in raw ? (raw as { plan?: unknown }).plan : undefined;
  return typeof plan === "string" && plan.trim().length > 0 ? plan.trim() : undefined;
};

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];

/** What `registerExtensions` gives the runtime it wraps: t3's proposed-plan capture. */
export interface GuardSlot {
  capture: ((input: { readonly planMarkdown: string }) => Effect.Effect<void>) | undefined;
  /** Why the session was ended for its mode; from then on no request is answered and no prompt sent. */
  drifted: string | undefined;
  /** Fails a running prompt with the drift, so t3's failure names it (`cliPromptFailure`). */
  readonly signal: Deferred.Deferred<never, EffectAcpErrors.AcpError>;
}

/** The slot of each runtime this module wrapped, for the flavor's `registerExtensions`. */
export const guardSlots = new WeakMap<object, GuardSlot>();

const drift = (cli: AcpCli, runtime: Runtime, slot: GuardSlot, why: string) =>
  Effect.gen(function* () {
    slot.drifted ??= why;
    console.warn(JSON.stringify({ t3flare: "acp-mode-drift", cli, why }));
    const error = new EffectAcpErrors.AcpTransportError({ detail: `${MODE_DRIFT} (${why})`, cause: why });
    yield* Deferred.fail(slot.signal, error);
    if (runtime.terminateProcessGroup !== undefined) yield* Effect.ignore(runtime.terminateProcessGroup);
    return yield* error;
  });

/**
 * The runtime t3's adapter drives, wrapped:
 * - `start`, `loadSession`, `resumeSession` fail, ending the process, when the modes are not trusted (review F4);
 * - a `current_mode_update` or `config_option_update` to a mode we did not pin ends the process before t3 sees it;
 * - Claude's `ExitPlanMode` request in plan mode hands its plan to t3 (review F1) before t3's handler denies it.
 */
export const guardedRuntime = (cli: AcpCli, runtime: Runtime): Runtime => {
  const slot: GuardSlot = { capture: undefined, drifted: undefined, signal: Deferred.makeUnsafe<never, EffectAcpErrors.AcpError>() };
  const refuseAfterDrift = Effect.suspend(() =>
    slot.drifted === undefined ? Effect.void : Effect.fail(new EffectAcpErrors.AcpTransportError({ detail: `${MODE_DRIFT} (${slot.drifted})`, cause: slot.drifted })),
  );
  const checked = <E>(effect: Effect.Effect<AcpSessionRuntime.AcpSessionRuntimeStartResult, E>) =>
    Effect.gen(function* () {
      const result = yield* effect;
      const problem = modeStateProblem(cli, yield* runtime.getModeState) ?? configModeProblem(cli, yield* runtime.getConfigOptions);
      if (problem !== undefined) return yield* drift(cli, runtime, slot, problem);
      return result;
    });
  const wrapped: Runtime = {
    ...runtime,
    start: () => checked(runtime.start()),
    loadSession: (sessionId, options) => checked(runtime.loadSession(sessionId, options)),
    resumeSession: (sessionId, options) => checked(runtime.resumeSession(sessionId, options)),
    prompt: (payload, options) => refuseAfterDrift.pipe(Effect.andThen(Effect.raceFirst(runtime.prompt(payload, options), Deferred.await(slot.signal)))),
    handleSessionUpdate: (handler) =>
      runtime.handleSessionUpdate((notification) =>
        Effect.gen(function* () {
          const update = notification.update;
          const problem =
            update.sessionUpdate === "current_mode_update" && !ALLOWED_MODES[cli].has(update.currentModeId)
              ? `the agent switched to mode ${update.currentModeId}`
              : update.sessionUpdate === "config_option_update"
                ? configModeProblem(cli, update.configOptions)
                : undefined;
          if (problem !== undefined) return yield* drift(cli, runtime, slot, problem);
          return yield* handler(notification);
        }),
      ),
    handleRequestPermission: (handler) =>
      runtime.handleRequestPermission((params, context) =>
        Effect.gen(function* () {
          // Fail closed: once the agent left its mode, nothing it asks is answered.
          if (slot.drifted !== undefined) return { outcome: { outcome: "cancelled" } } as const;
          const plan = cli === "claude" ? exitPlanMarkdown(params) : undefined;
          if (plan !== undefined && slot.capture !== undefined && (yield* runtime.getModeState)?.currentModeId === "plan") {
            yield* slot.capture({ planMarkdown: plan });
          }
          return yield* handler(params, context);
        }),
      ),
  };
  guardSlots.set(wrapped, slot);
  return wrapped;
};
