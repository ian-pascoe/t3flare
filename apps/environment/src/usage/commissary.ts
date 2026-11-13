// @effect-diagnostics globalDate:off extendsNativeError:off
// Parity G8 (SPI-999): t3's Usage page and limit meters, fed from Commissary, the model proxy (ADR-0012). Every model
// call t3flare makes goes through Commissary, so its request log is this Environment's usage, and its accounts' quota
// reports are the limits the agents run into.
//
// Commissary has no usage or quota route for API keys: both are on its management API (`/v9/management/...`), on the
// app host, behind Cloudflare Access on a self-hosted deployment, and they refuse `cms_` keys. So reading them takes an
// org-admin management key (`cmsm_`) and, self-hosted, an Access service token: Worker secrets of the Environment
// Worker alone, never a Container's (`COMMISSARY_MANAGEMENT_*`, alchemy.run.ts). Unset, nothing here runs and the
// pages stay as they were (no meters, no usage, no error).
//
// t3's own `cliproxy` source cannot point at Commissary: it speaks CLIProxyAPI's `/v0/management` (`auth-files` and
// the token-substituting `api-call`), which Commissary did not port. Shapes: `~/src/commissary/packages/contract/src/
// credentials.ts` (`CredentialList`, `QuotaReport`) and `usage.ts` (`UsageRecordsPage`).
import type { UsageLimitSourceAccount, UsageLimitSourceSnapshot, UsageProviderKind } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

/** The Environment Worker's settings for Commissary's management API; `undefined` when not set (the default). */
export interface CommissaryManagement {
  /** The app host's origin, e.g. `https://commissary.example.com` (the management API is not on the API host). */
  readonly url: string;
  /** An org's slug; unset means the management key's own org (Commissary's unscoped management URLs). */
  readonly org?: string;
  /** `cmsm_…`, an org admin's (a plain member's key reads nothing of the org's accounts or of API keys' requests). */
  readonly managementKey: string;
  /** Self-hosted Commissary: the Access service token its Access application admits for the management API. */
  readonly access?: { readonly clientId: string; readonly clientSecret: string };
  /** Usage records counted here: the principals of t3flare's own API keys (`key:<key id>`). */
  readonly principals: ReadonlyArray<string>;
}

/** `key:<key id>` of a Commissary API key (`cms_<org id>_<key id>_<secret>`), or undefined for another text. */
export const principalOfApiKey = (key: string | undefined): string | undefined => {
  if (key === undefined || !key.startsWith("cms_")) return undefined;
  const [, keyId] = key.slice("cms_".length).split("_");
  return keyId === undefined || keyId === "" ? undefined : `key:${keyId}`;
};

/**
 * The settings from the Worker's bindings, or undefined unless the URL and the management key are both set. A service
 * token is used only when both of its halves are set.
 */
export const commissaryManagementOf = (env: {
  readonly COMMISSARY_MANAGEMENT_URL?: string | undefined;
  readonly COMMISSARY_MANAGEMENT_ORG?: string | undefined;
  readonly COMMISSARY_MANAGEMENT_KEY?: string | undefined;
  readonly COMMISSARY_ACCESS_CLIENT_ID?: string | undefined;
  readonly COMMISSARY_ACCESS_CLIENT_SECRET?: string | undefined;
  readonly COMMISSARY_USAGE_PRINCIPALS?: string | undefined;
  readonly MODEL_PROXY_API_KEY?: string | undefined;
}): CommissaryManagement | undefined => {
  const url = env.COMMISSARY_MANAGEMENT_URL?.trim().replace(/\/+$/, "");
  const managementKey = env.COMMISSARY_MANAGEMENT_KEY?.trim();
  if (!url || !managementKey) return undefined;
  const listed = (env.COMMISSARY_USAGE_PRINCIPALS ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  const own = principalOfApiKey(env.MODEL_PROXY_API_KEY);
  const principals = [...new Set([...(own === undefined ? [] : [own]), ...listed])];
  const org = env.COMMISSARY_MANAGEMENT_ORG?.trim();
  const clientId = env.COMMISSARY_ACCESS_CLIENT_ID?.trim();
  const clientSecret = env.COMMISSARY_ACCESS_CLIENT_SECRET?.trim();
  return {
    url,
    managementKey,
    principals,
    ...(org ? { org } : {}),
    ...(clientId && clientSecret ? { access: { clientId, clientSecret } } : {}),
  };
};

// ---- Commissary's wire shapes (only the fields read here) ----

export interface QuotaWindow {
  readonly id: string;
  readonly label: string;
  readonly used_percent: number;
  readonly resets_at?: string;
  readonly window_seconds?: number;
}

export interface CredentialEntry {
  readonly id: string;
  readonly auth_index: string;
  readonly provider: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly email?: string;
  readonly account?: string;
  readonly id_token?: { readonly plan_type?: string; readonly chatgpt_account_id?: string };
  readonly quota_report?: {
    readonly checked_at: string;
    readonly refreshed_at?: string;
    readonly plan?: string;
    readonly windows: ReadonlyArray<QuotaWindow>;
    readonly error?: string;
  };
}

export interface CredentialList {
  readonly files: ReadonlyArray<CredentialEntry>;
}

export interface CommissaryUsageRecord {
  readonly timestamp: string;
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly api_key: string;
  readonly request_id: string;
  readonly failed: boolean;
  readonly session_id?: string;
  readonly service_tier?: string;
  readonly token_breakdown: {
    readonly input: { readonly uncached_tokens: number; readonly cache_read_tokens: number; readonly cache_write_tokens: number };
    readonly output: { readonly total_tokens: number; readonly reasoning_tokens: number };
  };
  readonly cost_micros?: number;
  readonly unpriced?: boolean;
  readonly area?: string;
}

export interface UsageRecordsPage {
  readonly records: ReadonlyArray<CommissaryUsageRecord>;
  readonly next_before?: string;
}

// ---- Limits: Commissary's accounts as one t3 usage-limit source ----

/** The id and label of the source t3 shows (Settings → Usage limits, the Usage page's meters). */
export const COMMISSARY_SOURCE_ID = "commissary";
export const COMMISSARY_SOURCE_LABEL = "Commissary";

/** Commissary's quota providers (`packages/models/src/quota/report.ts`) that t3 has a driver for. */
const DRIVER_OF: Readonly<Record<string, string>> = {
  claude: "claudeAgent",
  codex: "codex",
  antigravity: "antigravity",
  xai: "grok",
  "opencode-go": "opencode",
};

const windowKind = (id: string): "session" | "weekly" | "monthly" | "other" => {
  if (id === "five_hour" || id === "primary" || id === "session") return "session";
  if (id.startsWith("seven_day") || id === "weekly" || id === "secondary") return "weekly";
  if (id === "monthly") return "monthly";
  return "other";
};

const nonEmpty = (text: string | undefined): string | undefined => {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
};

const isoOrUndefined = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};

/**
 * One t3 account per enabled Commissary account whose provider t3 knows and that has a quota report. An account
 * whose last check failed keeps its last windows; with none, t3 is told the probe failed.
 */
export const limitAccounts = (list: CredentialList): ReadonlyArray<UsageLimitSourceAccount> =>
  list.files.flatMap((entry): ReadonlyArray<UsageLimitSourceAccount> => {
    const driver = DRIVER_OF[entry.provider];
    const report = entry.quota_report;
    if (driver === undefined || entry.disabled || report === undefined) return [];
    const checkedAt = isoOrUndefined(report.refreshed_at) ?? isoOrUndefined(report.checked_at) ?? new Date(0).toISOString();
    const windows = report.windows.map((window) => {
      const resetsAt = isoOrUndefined(window.resets_at);
      return {
        id: window.id,
        kind: windowKind(window.id),
        label: nonEmpty(window.label) ?? window.id,
        usedPercent: Math.min(100, Math.max(0, window.used_percent)),
        ...(resetsAt === undefined ? {} : { resetsAt }),
        ...(window.window_seconds === undefined ? {} : { windowDurationMins: Math.round(window.window_seconds / 60) }),
      };
    });
    const email = nonEmpty(entry.email);
    const plan = nonEmpty(report.plan) ?? nonEmpty(entry.id_token?.plan_type);
    const workspaceId = nonEmpty(entry.id_token?.chatgpt_account_id);
    const error = nonEmpty(report.error);
    return [
      {
        id: entry.auth_index,
        driver: driver as UsageLimitSourceAccount["driver"],
        ...(email === undefined ? {} : { email }),
        ...(plan === undefined ? {} : { plan }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        usageLimits: {
          checkedAt: checkedAt as UsageLimitSourceAccount["usageLimits"]["checkedAt"],
          windows,
          ...(windows.length === 0 && error !== undefined ? { unavailable: { reason: "probeFailed" as const, message: error } } : {}),
        },
      } as UsageLimitSourceAccount,
    ];
  });

/** The snapshot t3 shows for Commissary: its accounts, or the read's failure. */
export const limitSnapshot = (checkedAt: string, read: { readonly list: CredentialList } | { readonly error: string }): UsageLimitSourceSnapshot =>
  ({
    id: COMMISSARY_SOURCE_ID,
    kind: "cliproxy",
    label: COMMISSARY_SOURCE_LABEL,
    checkedAt,
    ...("list" in read ? { accounts: limitAccounts(read.list) } : { accounts: [], error: read.error }),
  }) as UsageLimitSourceSnapshot;

// ---- Usage: Commissary's request log as t3 usage records ----

/** The t3 usage providers Commissary's records are counted under. */
export const USAGE_PROVIDERS = ["pi", "codex", "claude", "opencode"] as const satisfies ReadonlyArray<UsageProviderKind>;
export type CommissaryUsageProvider = (typeof USAGE_PROVIDERS)[number];

/**
 * Which of t3flare's agents made a request, from what Commissary recorded of it: Codex by its session identity or the
 * Responses API, Claude Code by its session header, OpenCode by its affinity header. The rest is Pi: the Durable agent,
 * text generation (titles, commit and PR text) and the pi CLI, none of which marks its requests.
 */
export const usageProviderOf = (record: Pick<CommissaryUsageRecord, "session_id" | "endpoint">): CommissaryUsageProvider => {
  const session = record.session_id ?? "";
  if (session.startsWith("codex:") || /\/responses\b|\/backend-api\/codex/.test(record.endpoint)) return "codex";
  if (session.startsWith("claude:")) return "claude";
  if (session.startsWith("affinity:")) return "opencode";
  return "pi";
};

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);

/** A t3 usage record of one of Commissary's, or undefined for a failed attempt, a tool call or an unreadable one. */
export const toUsageRecord = (record: CommissaryUsageRecord): UsageRecord | undefined => {
  if (record.failed || (record.area !== undefined && record.area !== "models")) return undefined;
  const timestampMs = Date.parse(record.timestamp);
  if (Number.isNaN(timestampMs) || record.model === "") return undefined;
  const input = record.token_breakdown?.input;
  const output = record.token_breakdown?.output;
  const reported = record.unpriced !== true && typeof record.cost_micros === "number" && record.cost_micros > 0 ? record.cost_micros / 1_000_000 : null;
  return {
    provider: usageProviderOf(record),
    timestampMs,
    model: record.model,
    sessionId: record.session_id ?? "",
    totals: {
      uncachedInputTokens: count(input?.uncached_tokens),
      cachedInputTokens: count(input?.cache_read_tokens),
      cacheCreationTokens: count(input?.cache_write_tokens),
      outputTokens: count(output?.total_tokens),
      reasoningTokens: count(output?.reasoning_tokens),
    },
    // Commissary priced it when it was written, with the owner's prices; t3's rate table prices the rest.
    reportedCostUsd: reported,
    speed: record.service_tier === "priority" ? "fast" : "standard",
    dedupeKey: `commissary:${record.request_id}`,
  };
};

// ---- The client ----

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Most pages of records one read follows (1,000 records each): one subrequest per page. */
export const MAX_RECORD_PAGES = 25;
const PAGE_SIZE = 1000;
const TIMEOUT_MS = 15_000;

export class CommissaryError extends Error {}

const managementUrl = (config: CommissaryManagement, route: string, query: Record<string, string> = {}): string => {
  const base = config.org === undefined ? `${config.url}/v9/management` : `${config.url}/v9/management/orgs/${encodeURIComponent(config.org)}`;
  const search = new URLSearchParams(query).toString();
  return `${base}/${route}${search === "" ? "" : `?${search}`}`;
};

const headersOf = (config: CommissaryManagement): Record<string, string> => ({
  accept: "application/json",
  authorization: `Bearer ${config.managementKey}`,
  ...(config.access === undefined ? {} : { "cf-access-client-id": config.access.clientId, "cf-access-client-secret": config.access.clientSecret }),
});

/** Why a read failed, in words for t3's notice; never the key, never Commissary's body beyond its error code. */
const failure = async (response: Response): Promise<CommissaryError> => {
  let code = "";
  try {
    const body = (await response.json()) as { readonly error?: unknown };
    if (typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error)) code = ` (${body.error})`;
  } catch {
    // Not JSON (Access's login page, for one).
  }
  // A 3xx is Access sending an unadmitted caller to its sign-in page.
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400))
    return new CommissaryError(`Commissary refused t3flare's management key${code}: it needs an org admin's key, and the Access service token on a self-hosted Commissary.`);
  return new CommissaryError(`Commissary's management API answered HTTP ${response.status}${code}.`);
};

const getJson = async <T>(fetcher: Fetch, config: CommissaryManagement, route: string, query?: Record<string, string>): Promise<T> => {
  let response: Response;
  try {
    response = await fetcher(managementUrl(config, route, query), { headers: headersOf(config), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    throw new CommissaryError(`Commissary's management API did not answer: ${cause instanceof Error ? cause.name : "error"}.`);
  }
  if (!response.ok) throw await failure(response);
  try {
    return (await response.json()) as T;
  } catch {
    throw new CommissaryError("Commissary's management API answered something other than JSON (an Access sign-in page?).");
  }
};

export const readCredentials = (fetcher: Fetch, config: CommissaryManagement): Promise<CredentialList> =>
  getJson<CredentialList>(fetcher, config, "credentials").then((list) => ({ files: Array.isArray(list.files) ? list.files : [] }));

/**
 * Every successful model record since `sinceMs` of each principal, newest first, up to `MAX_RECORD_PAGES` pages each,
 * each kept as `keep` maps it (so a page's raw JSON is dropped before the next is read). `truncated` says a principal
 * had more.
 */
export const readUsageRecords = async <T>(
  fetcher: Fetch,
  config: CommissaryManagement,
  sinceMs: number,
  keep: (record: CommissaryUsageRecord) => T | undefined,
): Promise<{ readonly records: ReadonlyArray<T>; readonly truncated: boolean }> => {
  const records: T[] = [];
  let truncated = false;
  for (const principal of config.principals) {
    let before: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page === MAX_RECORD_PAGES) {
        truncated = true;
        break;
      }
      const query: Record<string, string> = { since: String(sinceMs), principal, area: "models", failed: "false", limit: String(PAGE_SIZE) };
      if (before !== undefined) query.before = before;
      const answer = await getJson<UsageRecordsPage>(fetcher, config, "observability/usage/records", query);
      for (const record of Array.isArray(answer.records) ? answer.records : []) {
        const kept = keep(record);
        if (kept !== undefined) records.push(kept);
      }
      if (answer.next_before === undefined || answer.next_before === "") break;
      before = answer.next_before;
    }
  }
  return { records, truncated };
};
