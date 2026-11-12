// The Codex request guard (step 4a, plan §3.1 with review F5): every request t3's Codex adapter sends to the app-server
// passes here first. Fail closed: methods and thread config keys are allowlisted; each turn's approval and sandbox
// policy come from t3flare's mode table (plan §5.1, M0 P2), whatever t3 or a launch asked.
import { CODEX_THREAD_CONFIG } from "t3/src/orchestration-v2/Adapters/CodexAdapterV2.ts";

/** The app-server methods t3's Codex adapter uses that t3flare lets through. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/read",
  "thread/sample",
  "thread/unarchive",
  "thread/unsubscribe",
  "thread/compact/start",
  "thread/goal/get",
  "thread/goal/set",
  "thread/goal/clear",
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  // Lists the MCP servers the thread has: t3's own and the relay's (ADR-0028, SPI-1039).
  "mcpServerStatus/list",
]);

/** Refused with their own reason (review F5): `feedback/*` uploads logs to the vendor, `account/*` is a vendor login. */
const REFUSED_PREFIXES: ReadonlyArray<[string, string]> = [
  ["feedback/", "feedback goes to the vendor, which t3flare never contacts"],
  ["account/", "the model proxy is the account; there is no Codex sign-in"],
];

/** Thread config keys let through: t3's own (`CODEX_THREAD_CONFIG`) and its per-thread shell variable. */
export const ALLOWED_THREAD_CONFIG: ReadonlySet<string> = new Set([...Object.keys(CODEX_THREAD_CONFIG), "shell_environment_policy.set.T3CODE_THREAD_ID"]);

/** t3's MCP entries (CodexAdapterV2's `mcp_servers.t3-code` and its direct-only twin), SPI-1039. */
const T3_MCP_KEYS: ReadonlySet<string> = new Set(["mcp_servers.t3-code", "mcp_servers.t3-code-direct"]);

/**
 * t3's own entry passes as stock t3 writes it (owner, 2026-11-12, back to stock): t3's public `/mcp` over https with
 * t3's per-thread bearer (relayedMcp.ts), and nothing else in it.
 */
export const isT3Server = (value: unknown): boolean => {
  const server = record(value);
  const headers = record(server.http_headers);
  let url: URL | undefined;
  try {
    url = typeof server.url === "string" ? new URL(server.url) : undefined;
  } catch {
    url = undefined;
  }
  return url?.protocol === "https:" && url.pathname === "/mcp" && url.search === "" && Object.keys(headers).length === 1 && typeof headers.Authorization === "string" && /^Bearer \S+$/.test(headers.Authorization);
};

/** Thread params that would set a policy or a provider beside the guard's: dropped (the process defaults apply). */
const DROPPED_THREAD_PARAMS = ["approvalPolicy", "approvalsReviewer", "sandbox", "sandboxPolicy", "modelProvider", "baseInstructions", "developerInstructions", "profile"];

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
  readonly approvalsReviewer: "user";
  readonly sandboxPolicy: { readonly type: "readOnly" | "workspaceWrite" | "dangerFullAccess" };
}

/**
 * The mode table (plan §5.1): t3's with a working sandbox; without one, everything but full access asks before every
 * command and patch (`untrusted`). `auto`, an unknown mode and plan run as approval-required.
 */
export const turnPolicy = (context: TurnContext, collaborationPlan: boolean): TurnPolicy => {
  const plan = collaborationPlan || (context.interactionMode !== undefined && context.interactionMode !== "default");
  const mode = plan ? "approval-required" : context.runtimeMode === "full-access" || context.runtimeMode === "auto-accept-edits" ? context.runtimeMode : "approval-required";
  if (mode === "full-access") return { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } };
  if (!context.sandbox) return { approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } };
  if (mode === "auto-accept-edits") return { approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite" } };
  return { approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } };
};

export type Guarded = { readonly params: unknown } | { readonly refused: string };

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {});

const threadParams = (params: unknown): Record<string, unknown> => {
  const next = record(params);
  for (const key of DROPPED_THREAD_PARAMS) delete next[key];
  if (next.config !== undefined) {
    next.config = Object.fromEntries(Object.entries(record(next.config)).filter(([key, value]) => ALLOWED_THREAD_CONFIG.has(key) || (T3_MCP_KEYS.has(key) && isT3Server(value))));
  }
  return next;
};

/** What reaches the app-server for t3's request, or why it does not. */
export const guardRequest = (method: string, params: unknown, context: TurnContext): Guarded => {
  for (const [prefix, why] of REFUSED_PREFIXES) if (method.startsWith(prefix)) return { refused: `t3flare refuses Codex's ${method}: ${why}` };
  if (!ALLOWED_METHODS.has(method)) return { refused: `t3flare does not pass Codex's ${method} on` };
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
