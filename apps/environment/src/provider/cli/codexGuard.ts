// The Codex request guard (step 4a, plan §3.1; back to stock, owner 2026-11-12): every request t3's Codex adapter sends
// to the app-server passes here first. t3's requests pass as t3 sends them, but three things: the provider pin (no
// thread param or config key may name another provider, profile or base URL, so the proxy key goes only to the proxy,
// K5), `feedback/*` and `account/*` (a vendor upload and a vendor sign-in, K3), and each turn's approval and sandbox
// policy, which come from t3's own mode table with a fallback when the Container has no working sandbox.
// (Until the cut, methods and thread config keys were allowlisted, and `auto` ran as approval-required.)

/** Refused with their own reason (review F5): `feedback/*` uploads logs to the vendor, `account/*` is a vendor login. */
const REFUSED_PREFIXES: ReadonlyArray<[string, string]> = [
  ["feedback/", "feedback goes to the vendor, which t3flare never contacts"],
  ["account/", "the model proxy is the account; there is no Codex sign-in"],
];

/** Thread params that would set a policy or a provider beside the guard's: dropped (the process defaults apply). */
const DROPPED_THREAD_PARAMS = ["approvalPolicy", "approvalsReviewer", "sandbox", "sandboxPolicy", "modelProvider", "profile"];

/** Thread config keys that would name another provider, profile or endpoint, or set a policy: dropped. */
const isPinnedConfigKey = (key: string): boolean =>
  key === "model_provider" ||
  key.startsWith("model_providers.") ||
  key === "profile" ||
  key.startsWith("profiles.") ||
  key === "openai_base_url" ||
  key === "chatgpt_base_url" ||
  key === "approval_policy" ||
  key === "approvals_reviewer" ||
  key === "sandbox_mode" ||
  key.startsWith("sandbox_workspace_write.");

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

export interface TurnContext {
  /** The thread's runtime mode as the wrapper saw it at the turn's start; undefined runs as approval-required. */
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  /** Whether bubblewrap works in the process's Container (P2: yes on Cloudflare; probed at each start). */
  readonly sandbox: boolean;
}

export interface TurnPolicy {
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
  readonly approvalsReviewer: "user" | "auto_review";
  readonly sandboxPolicy: { readonly type: "readOnly" | "workspaceWrite" | "dangerFullAccess" };
}

/**
 * t3's mode table (CodexAdapterV2's `codexPolicyForRuntimeMode`) with a working sandbox; without one, everything but
 * full access asks before every command and patch (`untrusted`). An unknown mode and plan run as approval-required.
 */
export const turnPolicy = (context: TurnContext, collaborationPlan: boolean): TurnPolicy => {
  const plan = collaborationPlan || (context.interactionMode !== undefined && context.interactionMode !== "default");
  const known = context.runtimeMode === "full-access" || context.runtimeMode === "auto-accept-edits" || context.runtimeMode === "auto";
  const mode = plan || !known ? "approval-required" : (context.runtimeMode as RuntimeMode);
  if (mode === "full-access") return { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } };
  if (!context.sandbox) return { approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } };
  if (mode === "auto") return { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: { type: "workspaceWrite" } };
  if (mode === "auto-accept-edits") return { approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite" } };
  return { approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } };
};

export type Guarded = { readonly params: unknown } | { readonly refused: string };

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {});

const threadParams = (params: unknown): Record<string, unknown> => {
  const next = record(params);
  for (const key of DROPPED_THREAD_PARAMS) delete next[key];
  if (next.config !== undefined) next.config = Object.fromEntries(Object.entries(record(next.config)).filter(([key]) => !isPinnedConfigKey(key)));
  return next;
};

/** What reaches the app-server for t3's request, or why it does not. */
export const guardRequest = (method: string, params: unknown, context: TurnContext): Guarded => {
  for (const [prefix, why] of REFUSED_PREFIXES) if (method.startsWith(prefix)) return { refused: `t3flare refuses Codex's ${method}: ${why}` };
  switch (method) {
    case "thread/start":
    case "thread/resume":
    case "thread/fork":
      return { params: threadParams(params) };
    case "turn/start": {
      const next = record(params);
      const plan = record(next.collaborationMode).mode === "plan";
      const policy = turnPolicy(context, plan);
      // Codex's sandbox is per turn; anything else that could change it is not passed on.
      delete next.sandbox;
      return { params: { ...next, ...policy } };
    }
    default:
      return { params };
  }
};

/** In plan mode a file change is declined before anyone is asked (plan §5.3). */
export const declinesInPlan = (method: string): boolean => method === "item/fileChange/requestApproval" || method === "applyPatchApproval";
