// Every Settings change, called by both doors (ADR-0035, plan D1): the Settings page's handlers, moved here as functions
// over the same dependencies, with no `Request` or `Response` in their signatures. The panel calls these and nothing
// else, and so do both doors of the Settings server, except `setMcpHeader` and `beginMcpSignIn`: a header value and an
// authorization URL never travel in a tool's arguments or result (ADR-0035), so those two run from the panel and the
// Change page only. Each takes the change, an optional `expectedRevision` (the
// revision of the entity it changes, plan D15: a moved one is refused with the current revision), and an actor (who
// asked, through which door, and what answered), and answers an outcome with the new revision, or a refusal with an
// HTTP-like status and the registry's words.
//
// Not here, and not offered through the Settings server: the per-Project `overrides` seam, every `/_t3flare` admin route
// outside the panel, and reading any secret.
import {
  applyChange,
  applyToolsChange,
  applyEnvironmentChange,
  applyMcpChange,
  digestOf,
  type EnvironmentKey,
  type HarnessChange,
  ignoredServersOf,
  type McpChange,
  type McpServerSetting,
  mcpServersOf,
  ownEntry,
  resolveEnvironment,
  resolveHarness,
  settingOf,
  type StoredHarness,
  T3_SERVER,
  type ToolsChange,
  withoutQuery,
} from "@t3flare/harness-registry";

import type { McpHost } from "../mcp/host.ts";
import { SKILLS_WRITE_ROUTES, skillsChange, type SkillsAnswer, type SkillsApiDeps } from "../skills/api.ts";
import type { HarnessOAuth } from "./oauth.ts";
import type { HarnessSecrets, SecretMark } from "./secrets.ts";
import type { AuditActor, AuditEntry, HarnessStore } from "./store.ts";

/** What every Settings change runs over. */
export interface OpsDeps {
  readonly store: HarnessStore;
  /** The MCP host (ADR-0028): the servers' inventories and their test. */
  readonly mcp?: Pick<McpHost, "servers" | "inventory" | "tools" | "list" | "forget">;
  /** Direct servers' write-only secrets. */
  readonly secrets?: HarnessSecrets;
  /** OAuth sign-ins. */
  readonly oauth?: Pick<HarnessOAuth, "begin" | "forget">;
  /** The Environment skills (SPI-1148): their store and GitHub reads. */
  readonly skills?: Omit<SkillsApiDeps, "caller" | "now" | "expectedRevision">;
  readonly now: () => number;
}

/** One change's who and against what. */
export interface OpOptions {
  readonly actor: AuditActor;
  /** The revision of the entity the change is to: optional for the panel, required from the Settings server (plan D15). */
  readonly expectedRevision?: number;
}

/** A refused change: nothing was stored. `revision` is the entity's current one when the refusal is for a moved revision. */
export interface Refusal {
  readonly ok: false;
  readonly status: 400 | 404 | 409 | 500 | 502;
  readonly error: string;
  readonly revision?: number;
}

export type Outcome<T> = ({ readonly ok: true } & T) | Refusal;

const refuse = (status: Refusal["status"], error: string): Refusal => ({ ok: false, status, error });

/** A moved revision's refusal, or undefined when none was expected or it has not moved. */
const moved = (entity: "Harness" | "Environment", current: number, expected: number | undefined): Refusal | undefined =>
  expected === undefined || expected === current
    ? undefined
    : { ok: false, status: 409, error: `the ${entity} settings are at revision ${current}, not ${expected}; read them again`, revision: current };

const audit = (deps: OpsDeps, actor: AuditActor, entry: Omit<AuditEntry, keyof AuditActor | "at"> & { readonly at?: number }) =>
  deps.store.audit({ ...actor, ...entry, at: entry.at ?? deps.now() });

/**
 * A stored entry the set ignored (a Direct server named `settings` from before the name was reserved) is dropped from
 * storage by the next change to the set: its header value and OAuth sign-in go with it (SPI-1198 review), unless the
 * change itself added a Direct server under that name.
 */
const dropIgnored = (deps: OpsDeps, before: StoredHarness, after: StoredHarness) => {
  const kept = after.mcp?.servers ?? {};
  for (const name of ignoredServersOf(before)) {
    // A Direct server stored under the name now is one this change added (never the dropped one): its secrets stay.
    if (ownEntry(kept, name)?.kind === "direct") continue;
    deps.secrets?.remove(name, ["header"]);
    deps.oauth?.forget(name);
  }
};

/** One extension's switch or settings (ADR-0026): validated against its registry entry, it bumps the Harness revision. */
export const changeExtension = (deps: OpsDeps, change: HarnessChange, options: OpOptions): Outcome<{ revision: number; resolved: ReturnType<typeof resolveHarness> }> => {
  const before = deps.store.load();
  const applied = applyChange(before, change);
  if (!applied.ok) return refuse(400, applied.error);
  const stale = moved("Harness", before.revision, options.expectedRevision);
  if (stale !== undefined) return stale;
  deps.store.save(applied.harness);
  audit(deps, options.actor, {
    entity: "harness",
    action: "extension.change",
    target: change.extension,
    before: before.global.extensions?.[change.extension] ?? null,
    after: applied.harness.global.extensions?.[change.extension] ?? null,
  });
  return { ok: true, revision: applied.harness.revision, resolved: resolveHarness(applied.harness) };
};

/**
 * Tools' Exposures (harness-registry's tools.ts): a preset applied first, then each tool named, built-in or t3's. It
 * bumps the Harness revision; the audit entry has the tools' stored Exposures before and after.
 */
export const changeTools = (deps: OpsDeps, change: ToolsChange, options: OpOptions): Outcome<{ revision: number; resolved: ReturnType<typeof resolveHarness> }> => {
  const before = deps.store.load();
  const applied = applyToolsChange(before, change);
  if (!applied.ok) return refuse(400, applied.error);
  const stale = moved("Harness", before.revision, options.expectedRevision);
  if (stale !== undefined) return stale;
  deps.store.save(applied.harness);
  // A preset sets MCP servers' Exposures too, and drops an entry the set ignores as any change to the set does.
  if (change.preset !== undefined) dropIgnored(deps, before, applied.harness);
  const named = [
    ...(change.preset === undefined ? [] : [`preset ${change.preset}`]),
    ...Object.keys(change.tools ?? {}),
    ...Object.keys(change.t3?.tools ?? {}).map((tool) => `${T3_SERVER}/${tool}`),
    ...(change.t3?.exposure === undefined ? [] : [T3_SERVER]),
  ];
  const servers = (harness: StoredHarness) => (change.preset === undefined ? {} : { mcp: harness.mcp?.servers ?? {} });
  audit(deps, options.actor, {
    entity: "harness",
    action: "tools.change",
    target: named.join(", ") || "tools",
    before: { tools: before.global.tools ?? {}, t3: before.global.t3 ?? {}, ...servers(before) },
    after: { tools: applied.harness.global.tools ?? {}, t3: applied.harness.global.t3 ?? {}, ...servers(applied.harness) },
  });
  return { ok: true, revision: applied.harness.revision, resolved: resolveHarness(applied.harness) };
};

/**
 * Some of the Environment settings (ADR-0032): validated against their schema, it bumps only their revision, and the
 * audit entry has the changed settings as they resolved before and after. A change that moves nothing is stored, bumped
 * and audited as nothing (`unchanged`). Applies at each Workspace's next Container start.
 */
export const changeEnvironment = async (
  deps: OpsDeps,
  settings: Readonly<Record<string, unknown>>,
  options: OpOptions,
): Promise<Outcome<{ unchanged?: true; revision: number; resolved: ReturnType<typeof resolveEnvironment> }>> => {
  const before = deps.store.loadEnvironment();
  const applied = applyEnvironmentChange(before, { settings });
  if (!applied.ok) return refuse(400, applied.error);
  const stale = moved("Environment", before.revision, options.expectedRevision);
  if (stale !== undefined) return stale;
  const resolved = resolveEnvironment(applied.environment);
  if (applied.changed.length === 0) return { ok: true, unchanged: true, revision: applied.environment.revision, resolved };
  deps.store.saveEnvironment(applied.environment);
  const keys = applied.changed;
  // A `file` setting (the Global mise config) is audited as its size and SHA-256, not its text: the log is one stored
  // value of up to 1 000 entries (ADR-0032's Global mise config refinement, a departure from §3's values as resolved).
  const shown = async (key: EnvironmentKey, value: unknown) => (settingOf(key).schema.type === "file" ? digestOf(String(value)) : value);
  const pick = async (from: ReturnType<typeof resolveEnvironment>) => Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await shown(key, from[key])] as const)));
  audit(deps, options.actor, {
    entity: "environment",
    action: "environment.change",
    target: keys.join(", "),
    before: await pick(resolveEnvironment(before)),
    after: await pick(resolved),
  });
  return { ok: true, revision: applied.environment.revision, resolved };
};

/**
 * The panel's "test": lists the server now, from the MCP Worker. A read; never bumps a revision. Audited for the panel;
 * not through the Settings server (`audit: false`), whose reads must not evict the log of changes (SPI-1198 review).
 */
export const testMcpServer = async (
  deps: OpsDeps,
  server: string,
  options: Pick<OpOptions, "actor"> & { readonly audit?: boolean },
): Promise<Outcome<{ server: string; status: string; error: string | null; tools: number; refused: number; ms: number }>> => {
  if (deps.mcp === undefined || ownEntry(deps.mcp.servers(), server) === undefined) return refuse(404, "no such server");
  const started = deps.now();
  const inventory = await deps.mcp.list(server);
  if (options.audit !== false) audit(deps, options.actor, { entity: "harness", at: started, action: "mcp.test", target: server, after: { status: inventory.status } });
  return { ok: true, server, status: inventory.status, error: inventory.error ?? null, tools: Object.keys(inventory.definitions).length, refused: inventory.refused.length, ms: deps.now() - started };
};

/** A class or per-tool Exposure change is logged against its tool, anything else against its server. */
const auditTarget = (change: McpChange): string => {
  if (change.op === "class") return `${change.server}/${change.tool}`;
  const tools = change.op === "server" && change.toolExposure !== null && typeof change.toolExposure === "object" ? Object.keys(change.toolExposure) : [];
  return tools.length === 1 ? `${change.server}/${tools[0]}` : change.server;
};

/** One change to the MCP server set (enable, Exposure, a tool's class, remove); a removed server's secrets go at once. */
export const changeMcp = (deps: OpsDeps, change: McpChange, options: OpOptions): Outcome<{ revision: number }> => {
  // A Direct server is added with its secret through its own op (`addMcpServer`); here only what holds no secret.
  if (change.op === "add") return refuse(400, "add a server through /api/mcp/servers");
  const before = deps.store.load();
  const applied = applyMcpChange(before, change);
  if (!applied.ok) return refuse(400, applied.error);
  const stale = moved("Harness", before.revision, options.expectedRevision);
  if (stale !== undefined) return stale;
  deps.store.save(applied.harness);
  dropIgnored(deps, before, applied.harness);
  if (change.op === "remove") {
    deps.secrets?.remove(change.server, ["header"]);
    deps.oauth?.forget(change.server);
  }
  audit(deps, options.actor, {
    entity: "harness",
    action: `mcp.${change.op}`,
    target: auditTarget(change),
    before: before.mcp?.servers?.[change.server] ?? null,
    after: applied.harness.mcp?.servers?.[change.server] ?? null,
  });
  return { ok: true, revision: applied.harness.revision };
};

/** A Direct server to add: its sign-in as sent, checked here. */
export interface AddServer {
  readonly server: string;
  readonly url: string;
  readonly auth: { readonly kind?: unknown; readonly header?: unknown };
  /** A header sign-in's value: stored write-only, never answered or audited. */
  readonly value?: string;
}

/**
 * Adds a Direct server: its name, URL and sign-in, and for a header sign-in the value, stored write-only. The answer and
 * the audit log carry `set`, `setAt` and a fingerprint, never the value.
 */
export const addMcpServer = async (deps: OpsDeps, input: AddServer, options: OpOptions): Promise<Outcome<{ revision: number; secret?: SecretMark }>> => {
  const { server, url, auth, value } = input;
  if (auth.kind !== "none" && auth.kind !== "header" && auth.kind !== "oauth") return refuse(400, "auth.kind is none, header or oauth");
  if (auth.kind === "header" && typeof auth.header !== "string") return refuse(400, "a header sign-in needs its header name");
  if (auth.kind === "header" && (value === undefined || value === "")) return refuse(400, "a header sign-in needs its value");
  if (deps.secrets === undefined) return refuse(500, "no secret store");
  const before = deps.store.load();
  const applied = applyMcpChange(before, {
    op: "add",
    server,
    url,
    auth: auth.kind === "header" ? { kind: "header", header: String(auth.header) } : auth.kind === "oauth" ? { kind: "oauth" } : { kind: "none" },
  });
  if (!applied.ok) return refuse(400, applied.error);
  const stale = moved("Harness", before.revision, options.expectedRevision);
  if (stale !== undefined) return stale;
  const mark = auth.kind === "header" && value !== undefined ? await deps.secrets.put(server, "header", value) : undefined;
  deps.store.save(applied.harness);
  // A name that held a server before starts fresh: no old tool list shown as available, no old session id sent.
  deps.mcp?.forget(server);
  dropIgnored(deps, before, applied.harness);
  audit(deps, options.actor, {
    entity: "harness",
    action: "mcp.add",
    target: server,
    after: { ...applied.harness.mcp?.servers?.[server], ...(mark === undefined ? {} : { secret: mark }) },
  });
  return { ok: true, revision: applied.harness.revision, ...(mark === undefined ? {} : { secret: mark }) };
};

/**
 * Sets the header value of an existing header-auth Direct server (plan D1). The value goes to the secret store alone;
 * the answer and the audit entry (`mcp.secret.set`) carry its mark. No revision moves: the MCP host reads secrets per
 * call. `expectedRevision`, when given, is the Harness settings'.
 */
export const setMcpHeader = async (deps: OpsDeps, input: { readonly server: string; readonly value: unknown }, options: OpOptions): Promise<Outcome<{ revision: number; secret: SecretMark }>> => {
  const stored = deps.store.load();
  const setting = Object.hasOwn(mcpServersOf(stored), input.server) ? mcpServersOf(stored)[input.server] : undefined;
  if (setting === undefined || setting.kind !== "direct") return refuse(404, "no such direct server");
  if (setting.auth?.kind !== "header") return refuse(400, `${input.server} does not sign in with a header`);
  if (typeof input.value !== "string" || input.value === "") return refuse(400, "a header sign-in needs its value");
  if (deps.secrets === undefined) return refuse(500, "no secret store");
  const stale = moved("Harness", stored.revision, options.expectedRevision);
  if (stale !== undefined) return stale;
  const mark = await deps.secrets.put(input.server, "header", input.value);
  audit(deps, options.actor, { entity: "harness", action: "mcp.secret.set", target: input.server, after: { secret: mark } });
  return { ok: true, revision: stored.revision, secret: mark };
};

/**
 * Starts an OAuth sign-in for a Direct server added with `auth: oauth`: the URL the owner's browser opens. The server's
 * authorization server sends the browser back to the public callback (oauth.ts). No revision moves.
 */
export const beginMcpSignIn = async (deps: OpsDeps, server: string, options: OpOptions): Promise<Outcome<{ authorizationUrl: string }>> => {
  const setting = deps.mcp === undefined ? undefined : ownEntry(deps.mcp.servers(), server);
  if (setting === undefined || setting.kind !== "direct" || setting.url === undefined) return refuse(404, "no such direct server");
  if (setting.auth?.kind !== "oauth") return refuse(400, `${server} does not sign in with OAuth`);
  if (deps.oauth === undefined) return refuse(500, "no OAuth");
  const stale = moved("Harness", deps.store.load().revision, options.expectedRevision);
  if (stale !== undefined) return stale;
  const begun = await deps.oauth.begin(server, setting.url);
  if (!begun.ok) return refuse(502, `the sign-in could not start: ${begun.error}`);
  audit(deps, options.actor, { entity: "harness", action: "mcp.oauth.start", target: server, after: { registration: begun.value.registration } });
  return { ok: true, authorizationUrl: begun.value.authorizationUrl };
};

/** The skills routes that change the Environment skills (the others, preview and check, only read GitHub). */
const SKILLS_CHANGES: ReadonlySet<string> = new Set(["/install", "/update", "/remove", "/enable"]);

/**
 * One of the Environment skills' routes (ADR-0033): preview and check read; install, update, remove and enable change the
 * skills and bump the Environment settings' revision. A moved `expectedRevision` is refused before GitHub is read.
 */
export const changeSkills = async (deps: OpsDeps, route: (typeof SKILLS_WRITE_ROUTES)[number], body: Record<string, unknown>, options: OpOptions): Promise<SkillsAnswer> => {
  if (deps.skills === undefined) return { status: 404, text: "Not found" };
  if (SKILLS_CHANGES.has(route)) {
    const stale = moved("Environment", deps.store.loadEnvironment().revision, options.expectedRevision);
    if (stale !== undefined) return { status: 409, text: stale.error };
  }
  return skillsChange(
    { ...deps.skills, caller: options.actor, now: deps.now, ...(options.expectedRevision === undefined || !SKILLS_CHANGES.has(route) ? {} : { expectedRevision: options.expectedRevision }) },
    route,
    body,
  );
};

/** A Direct server's setting with its URL's query dropped (plan D14): what any reader but the panel is shown. */
export const redactServer = (setting: McpServerSetting): McpServerSetting => (setting.url === undefined ? setting : { ...setting, url: withoutQuery(setting.url) });

/** `value` without any `fingerprint` property, at any depth (a secret's mark, whichever entity wrote it); with `urls`, every http(s) URL also loses its query. */
const redactDeep = (value: unknown, urls: boolean): unknown => {
  if (typeof value === "string") return urls && /^https?:\/\//i.test(value) ? withoutQuery(value) : value;
  if (Array.isArray(value)) return value.map((inner) => redactDeep(inner, urls));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([key, inner]) => (key === "fingerprint" ? [] : [[key, redactDeep(inner, urls)]])));
  }
  return value;
};

/**
 * An audit entry as a reader other than the panel sees it (plan D14): the owner's Access subject dropped (`owner:<sub>`
 * reads `owner`), no secret's fingerprint in any entry (a Model endpoint's key mark included), and in a Harness entry
 * every URL without its query. The Environment settings' Variables keep their values, as on the page.
 */
export const redactAudit = (entry: AuditEntry): AuditEntry => {
  const redact = (value: unknown) => redactDeep(value, entry.entity === "harness");
  return {
    ...entry,
    caller: entry.caller.startsWith("owner:") ? "owner" : entry.caller,
    ...(entry.before === undefined ? {} : { before: redact(entry.before) }),
    ...(entry.after === undefined ? {} : { after: redact(entry.after) }),
  };
};

/** The audit log redacted, newest first: at most `limit` (1 to 50, default 20) entries older than the `before` index. */
export const readAudit = (deps: Pick<OpsDeps, "store">, input: { readonly limit?: number; readonly before?: number } = {}) => {
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 20)));
  const all = deps.store.auditLog(Number.MAX_SAFE_INTEGER);
  const start = input.before === undefined ? 0 : Math.max(0, all.length - Math.floor(input.before));
  const entries = all.slice(start, start + limit);
  const next = start + entries.length < all.length ? all.length - (start + entries.length) : undefined;
  return { entries: entries.map(redactAudit), ...(next === undefined ? {} : { before: next }) };
};
