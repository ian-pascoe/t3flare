// The Codex request guard (step 4a, plan §3.1; back to stock, owner 2026-11-12): every request t3's Codex adapter sends
// to the app-server passes here first. t3's requests pass as t3 sends them, but three things: the provider pin (no
// thread param or config key may name another provider, profile or base URL, so a model handle goes only to the model
// relay, K5), `feedback/*` and `account/*` (a vendor upload and a vendor sign-in, K3), and each turn's approval and sandbox
// policy, which come from t3's own mode table with a fallback when the Container has no working sandbox.
// (Until the cut, methods and thread config keys were allowlisted, and `auto` ran as approval-required.)
//
// SPI-1167: a model of a Model endpoint is `<endpointId>/<modelId>` in t3; Codex gets the model's own id and the
// endpoint's provider (`codexModelRoute`), named by the guard on every thread request. A thread stays on its provider:
// a turn on a model of another provider is refused (Codex's `turn/start` cannot move a thread to another provider).
// SPI-1176: an old model (`isRetiredSlug`: a bare id) runs on a Responses endpoint's model of its id, else the default
// model, the first Responses endpoint's first model.

import { endpointSlug, isRetiredSlug, parseEndpointSlug, retiredSelectionSlug } from "@t3flare/models/endpoints";

/** Refused with their own reason (review F5): `feedback/*` uploads logs to the vendor, `account/*` is a vendor login. */
const REFUSED_PREFIXES: ReadonlyArray<[string, string]> = [
  ["feedback/", "feedback goes to the vendor, which t3flare never contacts"],
  ["account/", "Codex is signed in to nothing here: its models are the Model endpoints'"],
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

/** Where a model of t3's goes in Codex: its provider and the id Codex sends. */
export interface CodexModelRoute {
  readonly provider: string;
  readonly model: string;
}

export interface TurnContext {
  /** The thread's runtime mode as the wrapper saw it at the turn's start; undefined runs as approval-required. */
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  /** Whether bubblewrap works in the process's Container (P2: yes on Cloudflare; probed at each start). */
  readonly sandbox: boolean;
  /** SPI-1167: where t3's model slug goes; absent, models pass as sent and the process's default provider applies. */
  readonly route?: (model: string) => CodexModelRoute;
  /** The provider the request's thread runs on, when the client has seen it (its start, resume or fork). */
  readonly threadProvider?: (threadId: string) => string | undefined;
}

/** What a route reads of Codex's endpoints: their ids and, for the default model, their models' ids. */
export interface CodexRouteEndpoint {
  readonly id: string;
  readonly models: ReadonlyArray<{ readonly id: string }>;
}

/**
 * A model's route (SPI-1167): a slug whose part before the first `/` is the id of one of Codex's (OpenAI Responses)
 * endpoints goes to that endpoint's provider with the rest as its id. An old model (SPI-1176,
 * `isRetiredSlug`: a bare id, `default`) goes to an endpoint model of its id, else the default model, the first
 * endpoint's first model (`retiredSelectionSlug`).
 * Any other slug (an endpoint that is gone, or not Codex's) names its own endpoint's provider, which Codex does not have,
 * so Codex refuses it; with no endpoint at all, the model goes as sent to no provider.
 */
export const codexModelRoute = (model: string, endpoints: ReadonlyArray<CodexRouteEndpoint>, providerOf: (endpointId: string) => string): CodexModelRoute => {
  const slug = parseEndpointSlug(model);
  if (slug !== undefined && endpoints.some((endpoint) => endpoint.id === slug.endpointId)) return { provider: providerOf(slug.endpointId), model: slug.modelId };
  if (slug === undefined || isRetiredSlug(model)) {
    const first = endpoints.find((endpoint) => endpoint.models.length > 0);
    const chosen = parseEndpointSlug(retiredSelectionSlug(model, endpoints, first === undefined ? undefined : endpointSlug(first.id, first.models[0]!.id)) ?? "");
    return chosen === undefined ? { provider: "", model } : { provider: providerOf(chosen.endpointId), model: chosen.modelId };
  }
  return { provider: providerOf(slug.endpointId), model: slug.modelId };
};

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

const threadParams = (params: unknown, context: TurnContext): Record<string, unknown> => {
  const next = record(params);
  for (const key of DROPPED_THREAD_PARAMS) delete next[key];
  if (next.config !== undefined) next.config = Object.fromEntries(Object.entries(record(next.config)).filter(([key]) => !isPinnedConfigKey(key)));
  if (context.route !== undefined && typeof next.model === "string") {
    const route = context.route(next.model);
    next.model = route.model;
    next.modelProvider = route.provider;
  }
  return next;
};

/** A turn's model (and its collaboration mode's) as Codex knows it, or why the turn cannot run on it. */
const turnModel = (next: Record<string, unknown>, context: TurnContext): string | undefined => {
  if (context.route === undefined || typeof next.model !== "string") return undefined;
  const route = context.route(next.model);
  const threadProvider = typeof next.threadId === "string" ? context.threadProvider?.(next.threadId) : undefined;
  if (threadProvider !== undefined && threadProvider !== route.provider) {
    return `this Codex thread runs on another Model endpoint than ${next.model}; Codex cannot move a thread between them: start a new thread for this model`;
  }
  next.model = route.model;
  const mode = record(next.collaborationMode);
  const settings = record(mode.settings);
  if (typeof settings.model === "string") next.collaborationMode = { ...mode, settings: { ...settings, model: context.route(settings.model).model } };
  return undefined;
};

/** What reaches the app-server for t3's request, or why it does not. */
export const guardRequest = (method: string, params: unknown, context: TurnContext): Guarded => {
  for (const [prefix, why] of REFUSED_PREFIXES) if (method.startsWith(prefix)) return { refused: `t3flare refuses Codex's ${method}: ${why}` };
  switch (method) {
    case "thread/start":
    case "thread/resume":
    case "thread/fork":
      return { params: threadParams(params, context) };
    case "turn/start": {
      const next = record(params);
      const plan = record(next.collaborationMode).mode === "plan";
      const policy = turnPolicy(context, plan);
      const refusal = turnModel(next, context);
      if (refusal !== undefined) return { refused: `t3flare: ${refusal}` };
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
