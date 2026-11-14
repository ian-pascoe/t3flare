// @effect-diagnostics globalDate:off globalTimers:off
// The Settings server (ADR-0034, plan D2, D3, D7, D8, D9, D14, D16, D17), pure over its deps: t3flare's own agents'
// door, M3 (SPI-1198) and M4 (SPI-1199). The MCP host calls it for the `settings` entry of the MCP server set, before any inventory or pausing
// logic, with the caller the Environment derived (never one the agent states) and the call's asker.
//
// - Reads run for every caller, linked work included, and never carry a secret value, a fingerprint, a URL's query or an
//   authorization URL (D14).
// - A write is judged here, once (D7), in this order: the access switch; Linked or unknown work (D3); plan mode (and no
//   mode record); validation by the registry; the expected revision (D15); the Change tier (D5); the caps (D16); then
//   run, or ask the owner on one owner-only approval card on the calling thread. The Session's `mcp` extension and the
//   relay keep only the plan refusal for this server and raise no card of their own.
// - An asked change (D8, D9) always asks, in every mode: it becomes an Open change (openChanges.ts), shown on an
//   owner-only approval card written here (never by the agent) and on the Change page, and the first answer wins. A
//   change that needs the page (a secret, a sign-in, or text too long for a card, D6) is approved on the page alone.
// - Every change goes through `ops.ts`, as the panel's do.
// - The Owner-client door (M5a, SPI-1200; `settingsOwnerCall`, at the end) shares the reads and the planned writes. An
//   Owner client has no thread or mode: a free change runs, and an asked change becomes an Open change in its
//   Elicitation mode, which the endpoint (endpoint.ts) delivers and the Change page answers.
import {
  applyChange,
  applyEnvironmentChange,
  applyMcpChange,
  CARD_TEXT_MAX,
  cardText,
  classOf,
  ENVIRONMENT_SETTINGS,
  EXTENSIONS,
  type HarnessChange,
  ignoredServersOf,
  type McpChange,
  mcpServersOf,
  ownEntry,
  PLAN_REFUSAL,
  resolveEnvironment,
  resolveHarness,
  SETTINGS_SERVER,
  type TierVerdict,
  tierOf,
  type ToolClass,
  visible,
  withoutQuery,
} from "@t3flare/harness-registry";
import type { McpAsker, McpQuestionAnswer, McpQuestionCard } from "@t3flare/session-protocol";

import { containerCostTable } from "../harness/containerCost.ts";
import {
  addMcpServer,
  beginMcpSignIn,
  changeEnvironment,
  changeExtension,
  changeMcp,
  changeSkills,
  type OpOptions,
  type OpsDeps,
  readAudit,
  setMcpHeader,
  testMcpServer,
} from "../harness/ops.ts";
import type { AuditActor } from "../harness/store.ts";
import { newCardId } from "../mcp/elicitation.ts";
import type { McpCallAnswer, McpHost } from "../mcp/host.ts";
import { previewAtCommit, viewSkill } from "../skills/api.ts";
import {
  APPLIED_CAP,
  APPLIED_WINDOW_MS,
  NETWORK_READ_CAP,
  NETWORK_READS,
  READ_CAP,
  READ_WINDOW_MS,
  canonicalJson, type ChangeCaller, type ChangeMode, CHANGE_TTL_MS, type AnsweredBy, type ChangeRecord, changeHash, durationText, isOpen, type NeedsPage, newChangeId, type SettingsChanges } from "./changes.ts";
import {
  type AnswerDeps,
  answerOpenChange,
  type ApplyResult,
  capRefusal,
  type ChangeOutcome,
  type ChangesApi,
  closeOpenChange,
  openChangeSummary,
  outcomeOf,
  waitForChange,
} from "./openChanges.ts";
import { askedByText, type ChangeItem, changeText, type ChangeView, environmentItems, extensionItems, mcpItems, shownSkill } from "./render.ts";
import { settingsToolOf } from "./tools.ts";
import { OFF_MESSAGE, type OwnCaller, type OwnerCaller, type ThreadLink, type ThreadModes } from "./caller.ts";

/** How long the owner's card waits (the MCP host's question wait, `QUESTION_WAIT_MS`). */
export const SETTINGS_CARD_WAIT_MS = CHANGE_TTL_MS;

export type { OwnCaller, OwnerCaller, ThreadLink, ThreadModes } from "./caller.ts";
export { OFF_MESSAGE } from "./caller.ts";

export interface SettingsServerDeps {
  readonly ops: OpsDeps & { readonly mcp: Pick<McpHost, "servers" | "inventory" | "tools" | "list"> };
  /** An OAuth server's sign-in state (never a token). */
  readonly oauthStatus?: (server: string) => { readonly signedIn: boolean; readonly expiresAt: number | null; readonly refreshable: boolean };
  /** The thread's Linked work (`threadLinkOf`). */
  readonly link: (thread: string) => ThreadLink;
  /** The thread's modes: the adapter's record for a Durable agent, `cliThreadState` for a CLI agent. */
  readonly modes: (caller: OwnCaller) => ThreadModes | undefined;
  readonly changes: SettingsChanges;
  /** The Harness panel's URL on the configured host, when known. */
  readonly panelUrl: () => string | undefined;
  /** The panel's Status. */
  readonly status?: () => Readonly<Record<string, unknown>>;
  /** The Containers running now. */
  readonly running?: () => Promise<{ readonly count: number; readonly holders: ReadonlyArray<string> } | null>;
  readonly log?: (event: Record<string, unknown>) => void;
  readonly cardWaitMs?: number;
}

export interface SettingsCallInput {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly caller: OwnCaller;
  readonly asker?: McpAsker;
  readonly signal?: AbortSignal;
}

/** The status every write's result carries (plan D11's `structuredContent`; `waiting` is an Owner client's, M5). */
export type WriteStatus = "applied" | "unchanged" | "waiting" | "declined" | "withdrawn" | "expired" | "moved" | "refused";

type Entity = "harness" | "environment";

export const LINKED_REFUSAL = "This thread is Linked work; the owner changes settings from his own thread, the Harness panel, or an Owner client.";
export const UNKNOWN_REFUSAL = "t3flare cannot establish where this thread comes from, so it may read settings and change none. The owner changes them from his own thread or the Harness panel.";
export const NO_MODES_REFUSAL = "t3flare has no record of this thread's modes (the Environment restarted during the turn), so it changes no settings now. Try again in the thread's next turn.";
export const READ_ONLY_REFUSAL = "The owner made the Settings server read-only; its write tools are refused. Only the Harness panel changes that.";

/** When a change applies, by what it changed (plan D17). */
export const APPLIES_AT = {
  harness: "Applies at each thread's next turn, this one included. A CLI agent's server list changes at its next process.",
  environment: "Applies when each Workspace's Container next starts. Not in a Container that is running now, this one included; do not retry to see it.",
  skills: "Files at each thread's next turn; the listing at the next context window; the composer at once.",
} as const;

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** Every http(s) URL inside `text` without its query (plan D14): an error or a listing may quote a Direct server's URL. */
const scrubText = (text: string): string => text.replace(/https?:\/\/[^\s"'<>`]+/gi, (url) => withoutQuery(url));

/**
 * `value` with every string scrubbed and every `fingerprint` dropped, at any depth (plan D14): for what describes the
 * MCP server set (a Direct server's URL may hold a key in its query), and only that (M3 review).
 */
const scrub = (value: unknown): unknown => {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "fingerprint").map(([key, inner]) => [key, scrub(inner)]));
  return value;
};

/**
 * A read's answer, as the page shows it (plan D14): Variables' values, the Global mise config and a SKILL.md appear as
 * they are, so a read-then-write of them round-trips unchanged (M3 review).
 */
const read = (value: Readonly<Record<string, unknown>>): McpCallAnswer => ({ kind: "result", isError: false, text: json(value), structured: value });

/** A read of the MCP server set: every URL without its query, no secret's fingerprint (plan D14). */
const readMcp = (value: Readonly<Record<string, unknown>>): McpCallAnswer => read(scrub(value) as Readonly<Record<string, unknown>>);

const readError = (text: string): McpCallAnswer => ({ kind: "result", isError: true, text: scrubText(text) });

const written = (status: WriteStatus, text: string, extra: Readonly<Record<string, unknown>> = {}): McpCallAnswer => ({
  kind: "result",
  isError: status !== "applied" && status !== "unchanged" && status !== "waiting",
  text,
  structured: { status, ...extra },
});

const stringArg = (args: Readonly<Record<string, unknown>>, key: string): string | undefined => (typeof args[key] === "string" ? (args[key] as string) : undefined);

const objectArg = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const getSettings = async (deps: SettingsServerDeps, args: Readonly<Record<string, unknown>>): Promise<McpCallAnswer> => {
  if (args.entity === "harness") {
    const stored = deps.ops.store.load();
    const resolved = resolveHarness(stored);
    return read({
      entity: "harness",
      revision: stored.revision,
      extensions: EXTENSIONS.map((entry) => ({
        id: entry.id,
        title: entry.title,
        description: entry.description,
        enabled: resolved.extensions[entry.id]?.enabled ?? false,
        switch:
          entry.locked !== undefined
            ? `locked: ${entry.locked}`
            : entry.default === "always"
              ? "always on"
              : entry.guard === true
                ? "a Guard: turning it on or off is asked"
                : "off to on is asked; on to off is free",
        settings: Object.entries(entry.settings).map(([key, setting]) => ({
          key,
          title: setting.title,
          description: setting.description,
          value: resolved.extensions[entry.id]?.settings[key],
          schema: setting.schema,
          tier: entry.guard === true ? "asked" : (setting.tier ?? "asked"),
        })),
      })),
    });
  }
  if (args.entity === "environment") {
    const stored = deps.ops.store.loadEnvironment();
    const resolved: Readonly<Record<string, unknown>> = resolveEnvironment(stored);
    return read({
      entity: "environment",
      revision: stored.revision,
      settings: Object.entries(ENVIRONMENT_SETTINGS).map(([key, setting]) => ({
        key,
        title: setting.title,
        description: setting.description,
        value: resolved[key],
        schema: setting.schema,
        tier: (setting as { readonly tier?: string }).tier ?? "asked",
      })),
      running: (await deps.running?.()) ?? null,
      costs: containerCostTable(resolveEnvironment(stored).containerBudget),
    });
  }
  return readError("entity is harness or environment");
};

const listMcpServers = async (deps: SettingsServerDeps, args: Readonly<Record<string, unknown>>): Promise<McpCallAnswer> => {
  const stored = deps.ops.store.load();
  const servers = mcpServersOf(stored);
  const named = stringArg(args, "server");
  if (named !== undefined && !Object.hasOwn(servers, named)) return readError(`No MCP server is named ${named}.`);
  const rows = [];
  for (const [name, server] of Object.entries(servers)) {
    if (named !== undefined && name !== named) continue;
    const inventory = deps.ops.mcp.inventory(name);
    const { tools, refused } = await deps.ops.mcp.tools(name, server, inventory);
    const secret = server.auth?.kind === "header" ? deps.ops.secrets?.mark(name, "header") : undefined;
    rows.push({
      name,
      kind: server.kind,
      enabled: server.enabled,
      exposure: server.exposure,
      ...(server.kind === SETTINGS_SERVER ? { writes: server.writes ?? true } : {}),
      ...(server.url === undefined ? {} : { url: withoutQuery(server.url) }),
      ...(server.auth === undefined ? {} : { auth: server.auth }),
      ...(secret === undefined ? {} : { secret: { set: secret.set, setAt: secret.setAt } }),
      ...(server.auth?.kind === "oauth" && deps.oauthStatus !== undefined ? { oauth: deps.oauthStatus(name) } : {}),
      status: inventory.status,
      listedAt: inventory.listedAt > 0 ? inventory.listedAt : null,
      tools: named === undefined ? tools.length : tools.map((tool) => ({ name: tool.upstream, class: tool.class, hint: tool.hinted, exposure: tool.exposure, description: tool.description })),
      ...(named === undefined || refused.length === 0 ? {} : { refused }),
    });
  }
  const ignored = ignoredServersOf(stored);
  return readMcp({
    revision: stored.revision,
    servers: rows,
    ...(ignored.length === 0 ? {} : { ignored: ignored.map((name) => `${name}: stored under a name or kind reserved for the Settings server, and ignored`) }),
  });
};

const listSkills = (deps: SettingsServerDeps, args: Readonly<Record<string, unknown>>): McpCallAnswer => {
  if (deps.ops.skills === undefined) return readError("The Environment skills are not available here.");
  const revision = deps.ops.store.loadEnvironment().revision;
  const name = stringArg(args, "name");
  if (name === undefined) return read({ revision, skills: deps.ops.skills.store.list() });
  const viewed = viewSkill(deps.ops.skills, name);
  return "json" in viewed ? read({ revision, ...(viewed.json as Record<string, unknown>) }) : readError(viewed.text);
};

const skillsRead = async (deps: SettingsServerDeps, route: "/preview" | "/check", body: Record<string, unknown>, actor: AuditActor): Promise<McpCallAnswer> => {
  const answer = await changeSkills(deps.ops, route, body, { actor });
  return "json" in answer && answer.status === 200 ? read(answer.json as Record<string, unknown>) : readError("text" in answer ? answer.text : json(answer.json));
};

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What running a planned write answered. `authorizationUrl` is a sign-in's, for the Change page's own response only. */
type RunResult =
  | { readonly ok: true; readonly unchanged?: boolean; readonly authorizationUrl?: string }
  | { readonly ok: false; readonly error: string; readonly moved?: number };

/** What an asked change shows (its items and fixed lines), or why it cannot be asked (a skill's preview failed). */
type Described = { readonly items: ReadonlyArray<ChangeItem>; readonly lines: ReadonlyArray<string> } | { readonly refused: string };

/** A write made ready: its entity, tier, what it shows when asked, and how it runs through the ops. */
/** What a write changes, in the words its card and page use, and when it applies (plan D17). */
interface Target {
  readonly entity: Entity;
  readonly subject: string;
  readonly appliesAt: string;
}

const TARGET = {
  extension: { entity: "harness", subject: "the Harness settings", appliesAt: APPLIES_AT.harness },
  mcp: { entity: "harness", subject: "the MCP server set (Harness settings)", appliesAt: APPLIES_AT.harness },
  environment: { entity: "environment", subject: "the Environment settings", appliesAt: APPLIES_AT.environment },
  skills: { entity: "environment", subject: "the Environment skills", appliesAt: APPLIES_AT.skills },
} as const satisfies Readonly<Record<string, Target>>;

interface Planned extends Target {
  readonly verdict: TierVerdict;
  /**
   * The change as validated, without anything the call carried that the change ignores (plan D16, SPI-1199 review): the
   * declined-repeat hash is of this, so junk keys in the arguments cannot dodge it.
   */
  readonly normalized: Readonly<Record<string, unknown>>;
  /** Its `describe` reads GitHub (a skill's preview at a commit): it counts toward the network read cap. */
  readonly network?: true;
  /** Its items for the card and the page; may read GitHub (a skill's preview), so only an asked change calls it. */
  readonly describe: () => Promise<Described>;
  /** Runs it. `secret` is a header value typed on the Change page; `shown` the Open change's view (a skill's digests). */
  readonly run: (options: OpOptions, extra?: { readonly secret?: string; readonly shown?: ChangeView }) => Promise<RunResult>;
}

type PlanOrRefusal = Planned | { readonly refused: string };


const fromOutcome = (outcome: { readonly ok: boolean; readonly error?: string; readonly status?: number; readonly revision?: number; readonly unchanged?: true }): RunResult =>
  outcome.ok
    ? { ok: true as const, ...(outcome.unchanged === true ? { unchanged: true } : {}) }
    : { ok: false as const, error: outcome.error ?? "refused", ...(outcome.status === 409 && outcome.revision !== undefined ? { moved: outcome.revision } : {}) };

const hintedClass = (deps: SettingsServerDeps) => (server: string, tool: string): ToolClass | undefined => {
  const definition = ownEntry(deps.ops.mcp.inventory(server).definitions, tool);
  if (definition === undefined) return undefined;
  const annotations = definition.annotations as { readonly readOnlyHint?: unknown } | undefined;
  return classOf(annotations === undefined ? {} : { annotations }, undefined);
};

const planExtension = (deps: SettingsServerDeps, args: Readonly<Record<string, unknown>>): PlanOrRefusal => {
  const extension = stringArg(args, "extension");
  if (extension === undefined) return { refused: "extension names one extension" };
  if (args.enabled !== undefined && typeof args.enabled !== "boolean") return { refused: "enabled is true or false" };
  const settings = args.settings === undefined ? undefined : objectArg(args.settings);
  if (args.settings !== undefined && settings === undefined) return { refused: "settings is an object of setting names and values" };
  const change: HarnessChange = { extension, ...(args.enabled === undefined ? {} : { enabled: args.enabled as boolean }), ...(settings === undefined ? {} : { settings }) };
  const stored = deps.ops.store.load();
  const applied = applyChange(stored, change);
  if (!applied.ok) return { refused: applied.error };
  return {
    ...TARGET.extension,
    verdict: tierOf({ entity: "extension", stored, change }),
    normalized: { ...change },
    describe: async () => extensionItems(stored, change),
    run: async (options) => fromOutcome(changeExtension(deps.ops, change, options)),
  };
};

/**
 * An MCP change with only the fields its op takes (SPI-1199 review): what the registry applies, the tier judges and the
 * declined-repeat hash covers. Anything else the call carried is dropped, so it cannot make a declined change look new.
 */
const normalizedMcp = (change: Readonly<Record<string, unknown>>): McpChange => {
  const pick = (keys: ReadonlyArray<string>) => Object.fromEntries(keys.filter((key) => change[key] !== undefined).map((key) => [key, change[key]]));
  switch (change.op) {
    case "server":
      return { op: "server", server: change.server, ...pick(["enabled", "exposure", "toolExposure", "writes"]) } as McpChange;
    case "class":
      return { op: "class", server: change.server, ...pick(["tool", "class"]) } as McpChange;
    case "add": {
      const auth = objectArg(change.auth) ?? {};
      return { op: "add", server: change.server, url: change.url, auth: { kind: auth.kind, ...(auth.kind === "header" ? { header: auth.header } : {}) } } as McpChange;
    }
    default:
      return { op: "remove", server: change.server } as McpChange;
  }
};

const planMcp = (deps: SettingsServerDeps, args: Readonly<Record<string, unknown>>): PlanOrRefusal => {
  const change = objectArg(args.change);
  if (change === undefined || typeof change.op !== "string" || typeof change.server !== "string") return { refused: "change is { op, server, … }" };
  const stored = deps.ops.store.load();
  const server = change.server;
  const secretSet = (name: string) => deps.ops.secrets?.mark(name, "header").set === true;
  if (change.op === "header-value") {
    const setting = ownEntry(mcpServersOf(stored), server);
    if (setting === undefined || setting.kind !== "direct") return { refused: `No Direct server is named ${server}.` };
    if (setting.auth?.kind !== "header") return { refused: `${server} does not sign in with a header.` };
    const tierChange = { op: "header-value", server } as const;
    // Its value is typed on the Change page alone (plan D6): it reaches `run` from there, never from a tool.
    return {
      ...TARGET.mcp,
      verdict: tierOf({ entity: "mcp", stored, change: tierChange }),
      normalized: tierChange,
      describe: async () => mcpItems(stored, tierChange, secretSet),
      run: async (options, extra) => fromOutcome(await setMcpHeader(deps.ops, { server, value: extra?.secret }, options)),
    };
  }
  if (change.op !== "server" && change.op !== "class" && change.op !== "add" && change.op !== "remove") return { refused: "op is server, class, add, remove or header-value" };
  if (change.op === "add") {
    const auth = objectArg(change.auth);
    if (auth === undefined || (auth.kind !== "none" && auth.kind !== "header" && auth.kind !== "oauth")) return { refused: "auth.kind is none, header or oauth" };
    if (auth.kind === "header" && typeof auth.header !== "string") return { refused: "a header sign-in names its header" };
    if (typeof change.url !== "string") return { refused: "add needs the server's url" };
  }
  const mcpChange = normalizedMcp(change);
  const applied = applyMcpChange(stored, mcpChange);
  if (!applied.ok) return { refused: applied.error };
  const verdict = tierOf({ entity: "mcp", stored, change: mcpChange, hintedClass: hintedClass(deps) });
  const describe = async () => mcpItems(stored, mcpChange, secretSet);
  if (mcpChange.op === "add") {
    // A header add takes its value on the Change page (plan D6): `run` gets it from there.
    const add = mcpChange;
    return {
      ...TARGET.mcp,
      verdict,
      normalized: add,
      describe,
      run: async (options, extra) =>
        fromOutcome(await addMcpServer(deps.ops, { server: add.server, url: add.url, auth: add.auth, ...(extra?.secret === undefined ? {} : { value: extra.secret }) }, options)),
    };
  }
  return { ...TARGET.mcp, verdict, normalized: mcpChange, describe, run: async (options) => fromOutcome(changeMcp(deps.ops, mcpChange, options)) };
};

const planSignIn = (deps: SettingsServerDeps, args: Readonly<Record<string, unknown>>): PlanOrRefusal => {
  const server = stringArg(args, "server") ?? "";
  const stored = deps.ops.store.load();
  const setting = ownEntry(mcpServersOf(stored), server);
  if (setting === undefined || setting.kind !== "direct") return { refused: `No Direct server is named ${server}.` };
  if (setting.auth?.kind !== "oauth") return { refused: `${server} does not sign in with OAuth.` };
  const change = { op: "sign-in", server } as const;
  // The sign-in starts in the owner's browser on the Change page (plan D6, O8): its authorization URL goes to the page alone.
  return {
    ...TARGET.mcp,
    verdict: tierOf({ entity: "mcp", stored, change }),
    normalized: change,
    describe: async () => mcpItems(stored, change, () => false),
    run: async (options) => {
      const begun = await beginMcpSignIn(deps.ops, server, options);
      return begun.ok ? { ok: true, authorizationUrl: begun.authorizationUrl } : fromOutcome(begun);
    },
  };
};

const planEnvironment = (deps: SettingsServerDeps, args: Readonly<Record<string, unknown>>): PlanOrRefusal => {
  const settings = objectArg(args.settings);
  if (settings === undefined) return { refused: "settings is an object of Environment settings" };
  const stored = deps.ops.store.loadEnvironment();
  const applied = applyEnvironmentChange(stored, { settings });
  if (!applied.ok) return { refused: applied.error };
  return {
    ...TARGET.environment,
    verdict: tierOf({ entity: "environment", stored, change: { settings } }),
    normalized: { settings },
    describe: async () => ({ items: environmentItems(stored, settings), lines: [] }),
    run: async (options) => fromOutcome(await changeEnvironment(deps.ops, settings, options)),
  };
};

/** The digests an Open change's skills were shown with, by folder (plan D8): the apply refuses others. */
const digestsOf = (shown: ChangeView | undefined): Readonly<Record<string, string>> | undefined => {
  const item = shown?.items.find((each) => each.kind === "skills");
  return item?.kind === "skills" ? Object.fromEntries(item.skills.map((skill) => [skill.path, skill.digest])) : undefined;
};

const planSkills = (deps: SettingsServerDeps, args: Readonly<Record<string, unknown>>): PlanOrRefusal => {
  const skills = deps.ops.skills;
  if (skills === undefined) return { refused: "The Environment skills are not available here." };
  const op = stringArg(args, "op");
  const name = stringArg(args, "name");
  const row = name === undefined ? undefined : skills.store.get(name);
  const skillsRun =
    (route: "/install" | "/update" | "/remove" | "/enable", body: Record<string, unknown>) =>
    async (options: OpOptions, extra?: { readonly shown?: ChangeView }): Promise<RunResult> => {
      const digests = digestsOf(extra?.shown);
      const answer = await changeSkills(deps.ops, route, { ...body, ...(digests === undefined ? {} : { digests }) }, options);
      if (answer.status === 200) {
        // An install answers each skill's own outcome: one kept is applied; none kept is a failure.
        const results = "json" in answer ? (answer.json as { readonly results?: ReadonlyArray<{ readonly name: string; readonly error?: string }> }).results : undefined;
        if (results !== undefined && results.length > 0 && results.every((result) => result.error !== undefined)) return { ok: false, error: results.map((result) => `${result.name}: ${result.error}`).join("; ") };
        return { ok: true };
      }
      const error = "text" in answer ? answer.text : json(answer.json);
      return answer.status === 409 ? { ok: false, error, moved: deps.ops.store.loadEnvironment().revision } : { ok: false, error };
    };
  const planned = (verdict: TierVerdict, normalized: Planned["normalized"], describe: Planned["describe"], run: Planned["run"], network?: true): Planned => ({
    ...TARGET.skills,
    verdict,
    normalized,
    describe,
    run,
    ...(network === undefined ? {} : { network }),
  });
  const preview = async (input: { readonly source: string; readonly commit: string; readonly folders: ReadonlyArray<string> }, op: "install" | "update", from?: string): Promise<Described> => {
    const found = await previewAtCommit({ reader: skills.reader, now: deps.ops.now }, input);
    if (!found.ok) return { refused: found.error };
    const missing = input.folders.filter((folder) => !found.preview.skills.some((skill) => skill.path === folder));
    if (missing.length > 0) return { refused: `no skill at ${missing.map((folder) => (folder === "" ? "the repo's root" : folder)).join(", ")} at ${input.commit.slice(0, 7)}; preview again` };
    return {
      items: [{ kind: "skills", op, source: input.source, repo: found.preview.repo, ref: found.preview.ref, commit: input.commit, ...(from === undefined ? {} : { from }), skills: found.preview.skills.map(shownSkill) }],
      lines: [],
    };
  };
  switch (op) {
    case "install": {
      const source = stringArg(args, "source");
      const commit = stringArg(args, "commit");
      if (source === undefined || commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) return { refused: "install names the source and the previewed 40-hex commit" };
      if (!Array.isArray(args.folders) || args.folders.length === 0 || !args.folders.every((folder) => typeof folder === "string")) return { refused: "install names at least one folder from the preview" };
      const folders = args.folders as ReadonlyArray<string>;
      return planned(tierOf({ entity: "skills", change: { op: "install" } }), { op, source, commit, folders: [...folders].sort() }, () => preview({ source, commit, folders }, "install"), skillsRun("/install", { source, commit, folders }), true);
    }
    case "update": {
      const commit = stringArg(args, "commit");
      if (row === undefined) return { refused: `No Environment skill is named ${name ?? ""}.` };
      if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) return { refused: "update names the 40-hex commit check_skill_updates answered" };
      const source = `https://github.com/${row.repo}/tree/${commit}${row.path === "" ? "" : `/${row.path}`}`;
      return planned(tierOf({ entity: "skills", change: { op: "update", name: row.name } }), { op, name: row.name, commit }, () => preview({ source, commit, folders: [row.path] }, "update", row.commit), skillsRun("/update", { name, commit }), true);
    }
    case "remove":
    case "enable":
    case "disable": {
      if (row === undefined) return { refused: `No Environment skill is named ${name ?? ""}.` };
      const describe = async (): Promise<Described> => ({ items: [{ kind: "skill", op, name: row.name, repo: row.repo, commit: row.commit }], lines: [] });
      if (op === "remove") return planned(tierOf({ entity: "skills", change: { op: "remove", name: row.name } }), { op, name: row.name }, describe, skillsRun("/remove", { name }));
      const enabled = op === "enable";
      return planned(tierOf({ entity: "skills", change: { op: "enable", name: row.name, enabled } }), { op, name: row.name }, describe, skillsRun("/enable", { name, enabled }));
    }
    default:
      return { refused: "op is install, update, enable, disable or remove" };
  }
};

const planWrite = (deps: SettingsServerDeps, tool: string, args: Readonly<Record<string, unknown>>): PlanOrRefusal => {
  switch (tool) {
    case "change_extension":
      return planExtension(deps, args);
    case "change_mcp":
      return planMcp(deps, args);
    case "start_mcp_sign_in":
      return planSignIn(deps, args);
    case "change_environment":
      return planEnvironment(deps, args);
    case "change_skills":
      return planSkills(deps, args);
    default:
      return { refused: `${tool} is not a write tool of the Settings server` };
  }
};

const revisionOf = (deps: SettingsServerDeps, entity: Entity): number => (entity === "harness" ? deps.ops.store.load().revision : deps.ops.store.loadEnvironment().revision);

/** The Change page's URL for `id` on the configured host, when known (plan D10). */
export const changeUrlOf = (deps: Pick<SettingsServerDeps, "panelUrl">, id: string): string | undefined => {
  const panel = deps.panelUrl();
  return panel === undefined ? undefined : `${panel}/changes/${id}`;
};

/** The panel's Open changes list (plan D10, D16). */
const openListOf = (deps: Pick<SettingsServerDeps, "panelUrl">): string | undefined => {
  const panel = deps.panelUrl();
  return panel === undefined ? undefined : `${panel}#changes`;
};

/** The calling thread and agent, as a card or page names them. */
const askedBy = (caller: OwnCaller): string => `Asked by ${askedByText(caller)}.`;

/** The agent's call, as a card shows it last. */
const callText = (tool: string, args: Readonly<Record<string, unknown>>): string => `The agent's call: settings: ${tool}\n${JSON.stringify(args, null, 2)}`;

const APPROVAL_OPTIONS: NonNullable<McpQuestionCard["options"]> = [
  { decision: "accept", label: "Approve" },
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Cancel" },
];

/** A change answered on the page (plan D9): "Opened it" only keeps the call waiting for the page. */
const PAGE_OPTIONS: NonNullable<McpQuestionCard["options"]> = [
  { decision: "accept", label: "Opened it" },
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Cancel" },
];

/** The owner-only approval card for a free write the thread's mode asks about (plan D7). */
const freeCard = (input: SettingsCallInput, planned: Planned, revision: number): McpQuestionCard => {
  const prompt = [
    `An agent asks to change ${planned.subject} (revision ${revision}):`,
    ...planned.verdict.reasons.map((reason) => `- ${reason}`),
    "",
    planned.appliesAt,
    `${askedBy(input.caller)} This change is free (it narrows what agents have); this thread's mode asks for every write.`,
    "",
    callText(input.tool, input.args),
  ].join("\n");
  return { id: newCardId(), kind: "approval", server: SETTINGS_SERVER, title: cardText(`settings: ${input.tool}?`, 200), prompt: cardText(prompt), options: APPROVAL_OPTIONS };
};

/**
 * The asked change's card text in full (plan D9): the change as the server resolved it, why it is asked, the fixed
 * lines, when it applies, who asked, the Change page's link, and the agent's call last.
 */
const askedText = (view: ChangeView, input: SettingsCallInput, url: string | undefined): string =>
  [changeText(view), "", askedBy(input.caller), ...(url === undefined ? [] : [`The Change page: ${url}`]), "", callText(input.tool, input.args)].join("\n");

/** The owner-only approval card for an asked change (plan D9); never a field, so no agent can answer it. */
/** Why a page-only change waits there, on its card (plan D6), by what it needs. */
const PAGE_ONLY: Readonly<Record<Exclude<NeedsPage, "oversize">, (where: string) => string>> = {
  secret: (where) => `It takes a secret, typed on ${where}.`,
  "sign-in": (where) => `The sign-in starts in your browser on ${where}.`,
  skills: (where) => `Each skill's SKILL.md text and files are shown on ${where}; review and approve them there.`,
};

export const askedCard = (view: ChangeView, input: SettingsCallInput, url: string | undefined, needsPage: NeedsPage | undefined): McpQuestionCard => {
  const full = askedText(view, input, url);
  const where = url === undefined ? "the Change page (its link is on the Harness panel's Open changes list)" : `the Change page: ${url}`;
  const prompt =
    needsPage === "oversize"
      ? [
          `An agent asks to change ${view.subject} (revision ${view.revision}). The change is too long to show on a card, so it is answered on ${where}`,
          "",
          askedBy(input.caller),
          `"Opened it" keeps the call waiting for the page; Decline and Cancel close it.`,
        ].join("\n")
      : needsPage === undefined
        ? full
        : [
            full,
            "",
            `${PAGE_ONLY[needsPage](where)} "Opened it" keeps the call waiting for the page.`,
          ].join("\n");
  return {
    id: newCardId(),
    kind: "approval",
    server: SETTINGS_SERVER,
    title: cardText(`settings: ${input.tool}?`, 200),
    prompt: cardText(prompt),
    options: needsPage === undefined ? APPROVAL_OPTIONS : PAGE_OPTIONS,
  };
};

/** The owner's answer on `card`, or a cancel when it is not answered in time or the call is stopped; the card is then withdrawn. */
const askOnCard = async (deps: SettingsServerDeps, asker: McpAsker, card: McpQuestionCard, signal: AbortSignal | undefined): Promise<McpQuestionAnswer> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const closed = new Promise<McpQuestionAnswer>((resolve) => {
    timer = setTimeout(() => resolve({ decision: "cancel", reason: "no answer in time" }), deps.cardWaitMs ?? SETTINGS_CARD_WAIT_MS);
    if (signal !== undefined) {
      onAbort = () => resolve({ decision: "cancel", reason: "the call was stopped" });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  let answer: McpQuestionAnswer;
  try {
    answer = await Promise.race([asker.ask(card), closed]);
  } catch (error) {
    answer = { decision: "cancel", reason: `the card could not be shown: ${String(error).slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
  if (answer.reason === "no answer in time" || answer.reason === "the call was stopped") await Promise.resolve(asker.withdraw(card.id)).catch(() => undefined);
  return answer;
};

/** The deps `answerOpenChange` runs over: the table, and the apply through the ops. */
export const answerDepsOf = (deps: SettingsServerDeps): AnswerDeps => ({
  changes: deps.changes,
  now: deps.ops.now,
  revisionOf: (entity) => revisionOf(deps, entity),
  apply: (record, input) => applyOpenChange(deps, record, input),
  ...(deps.log === undefined ? {} : { log: deps.log }),
});

/** The Change page's and the panel list's view of the Open changes (plan D10): answers there are by `page`. */
export const changesApiOf = (deps: SettingsServerDeps): ChangesApi => ({
  list: () => deps.changes.open(),
  get: (id) => deps.changes.get(id),
  answer: (id, input) => answerOpenChange(answerDepsOf(deps), id, { ...input, by: "page" }),
});

/** Who asked, as an asked change's audit entry keeps it (plan D15). */
const actorOfChange = (record: ChangeRecord, by: AnsweredBy): AuditActor => ({
  caller: record.caller.principal === "agent" ? `agent:${record.caller.key}` : record.caller.principal === "owner" ? `owner:${record.caller.key}` : "service-token",
  via: "mcp",
  ...(record.caller.thread === undefined ? {} : { thread: record.caller.thread }),
  ...(record.caller.agent === undefined ? {} : { agent: record.caller.agent }),
  ...(record.caller.client === undefined ? {} : { client: record.caller.client }),
  tier: "asked",
  ...(record.mode === undefined ? {} : { mode: record.mode }),
  answeredBy: by,
  change: record.id,
});

/**
 * Applies an answered Open change (plan D8): planned again from its tool and arguments against the settings as they are
 * now (the registry validates it again), and run with its expected revision. A secret goes from the page to `run` alone.
 */
export const applyOpenChange = async (deps: SettingsServerDeps, record: ChangeRecord, input: { readonly by: AnsweredBy; readonly secret?: string }): Promise<ApplyResult> => {
  // The owner may have switched the server off or read-only while it waited (M3 review): nothing applies then.
  const access = mcpServersOf(deps.ops.store.load())[SETTINGS_SERVER];
  if (access === undefined || !access.enabled) return { ok: false, error: OFF_MESSAGE };
  if (access.writes === false) return { ok: false, error: READ_ONLY_REFUSAL };
  const planned = planWrite(deps, record.tool, (record.args ?? {}) as Readonly<Record<string, unknown>>);
  if ("refused" in planned) return { ok: false, error: planned.refused };
  const ran = await planned.run(
    { actor: actorOfChange(record, input.by), ...(record.expectedRevision === undefined ? {} : { expectedRevision: record.expectedRevision }) },
    { ...(input.secret === undefined ? {} : { secret: input.secret }), ...(record.shown === undefined ? {} : { shown: record.shown }) },
  );
  if (!ran.ok) return ran;
  return { ok: true, revision: revisionOf(deps, planned.entity), ...(ran.authorizationUrl === undefined ? {} : { authorizationUrl: ran.authorizationUrl }) };
};

/** A closed change's answer to the agent (plan D11's statuses). */
const resultOf = (outcome: ChangeOutcome, record: Pick<ChangeRecord, "id" | "entity">, planned: Pick<Planned, "appliesAt">): McpCallAnswer => {
  const where = outcome.by === "page" ? " on the Change page" : outcome.by === "card" ? " on the card" : "";
  const name = record.entity === "harness" ? "Harness" : "Environment";
  switch (outcome.state) {
    case "applied":
      return written("applied", `Applied: the owner approved it${where}. The ${name} settings are at revision ${outcome.revision ?? "?"}. ${planned.appliesAt}`, {
        ...(outcome.revision === undefined ? {} : { revision: outcome.revision }),
        appliesAt: planned.appliesAt,
        changeId: record.id,
      });
    case "declined":
      return written("declined", `Not changed: the owner declined it${where}. Do not ask again for the same change.`, { changeId: record.id });
    case "expired":
      return written("expired", `Not changed: the owner did not answer within ${durationText(CHANGE_TTL_MS)}.`, { changeId: record.id });
    case "moved":
      return written("moved", `Not changed: the ${name} settings moved to revision ${outcome.revision ?? "?"} before it applied; read them again.`, {
        ...(outcome.revision === undefined ? {} : { revision: outcome.revision }),
        changeId: record.id,
      });
    case "withdrawn":
      return written("withdrawn", `Not changed: the change was withdrawn${where === "" ? "" : ` (${where.trim()})`} before an answer.`, { changeId: record.id });
    default:
      return written("refused", `Not changed: ${scrubText(outcome.error ?? "the change failed")}`, { changeId: record.id });
  }
};

/**
 * An own agent's asked change (plan D8, D9): opened as an Open change, shown on one owner-only approval card on the
 * calling thread, and answered by the card or the Change page, whichever comes first. It waits at most the change's 10
 * minutes; a Stop withdraws it.
 */
const ask = async (deps: SettingsServerDeps, input: SettingsCallInput, planned: Planned, expected: number, key: string): Promise<McpCallAnswer> => {
  const { caller, tool, args } = input;
  const now = deps.ops.now();
  const hash = await changeHash(tool, planned.normalized);
  const changeCaller = { door: "own" as const, key, principal: "agent" as const, thread: key, agent: caller.agent };
  const log = (outcome: string, extra: Record<string, unknown> = {}) => deps.log?.({ t3flare: "settings-refused", via: "mcp", door: "own", agent: caller.agent, thread: key, tool, outcome, ...extra });
  const capped = capRefusal(deps.changes, changeCaller, hash, now, openListOf(deps));
  if (capped !== undefined) {
    log("refused", { reason: capped.reason });
    return written("refused", capped.text, { tier: "asked", reason: capped.reason, ...(capped.changeId === undefined ? {} : { changeId: capped.changeId }) });
  }
  const spent = planned.network === true ? networkSpent(deps, ownReader(deps, caller)) : undefined;
  if (spent !== undefined) {
    log("refused", { reason: "network-read-cap" });
    return written("refused", spent);
  }
  const described = await planned.describe();
  if ("refused" in described) {
    log("refused", { reason: "invalid" });
    return written("refused", `Not changed: ${scrubText(described.refused)}`);
  }
  const view: ChangeView = { entity: planned.entity, subject: planned.subject, revision: expected, appliesAt: planned.appliesAt, reasons: planned.verdict.reasons, items: described.items, lines: described.lines };
  const id = newChangeId();
  const url = changeUrlOf(deps, id);
  const needsPage = planned.verdict.needsPage ?? (visible(askedText(view, input, url)).length > CARD_TEXT_MAX ? "oversize" : undefined);
  const record: ChangeRecord = {
    id,
    entity: planned.entity,
    expectedRevision: expected,
    tool,
    args: JSON.parse(canonicalJson(args)) as unknown,
    hash,
    tier: "asked",
    shown: view,
    ...(needsPage === undefined ? {} : { needsPage }),
    mode: "card",
    caller: changeCaller,
    createdAt: now,
    expiresAt: now + CHANGE_TTL_MS,
    state: "open",
  };
  // The caps again, in the same synchronous block as the insert (plan D16): the describe above awaited (a skill's
  // preview reads GitHub), so a parallel call may have opened one meanwhile.
  const raced = capRefusal(deps.changes, changeCaller, hash, deps.ops.now(), openListOf(deps));
  if (raced !== undefined) {
    log("refused", { reason: raced.reason });
    return written("refused", raced.text, { tier: "asked", reason: raced.reason, ...(raced.changeId === undefined ? {} : { changeId: raced.changeId }) });
  }
  deps.changes.insert(record);
  deps.log?.({ t3flare: "settings-change", via: "mcp", door: "own", agent: caller.agent, thread: key, tool, outcome: "open", change: id, tier: "asked", mode: "card", needsPage: needsPage ?? null });
  const answers = answerDepsOf(deps);
  const card = askedCard(view, input, url, needsPage);
  const waiter = waitForChange(id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  type Event = { readonly kind: "card"; readonly answer: McpQuestionAnswer } | { readonly kind: "closed"; readonly outcome: ChangeOutcome } | { readonly kind: "timeout" } | { readonly kind: "stop" };
  const ended = new Promise<Event>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(0, deps.cardWaitMs ?? record.expiresAt! - now));
    if (input.signal !== undefined) {
      onAbort = () => resolve({ kind: "stop" });
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  const closed = waiter.closed.then((outcome): Event => ({ kind: "closed", outcome }));
  let cardOpen = input.asker !== undefined;
  const cardAnswer: Promise<Event> =
    input.asker === undefined
      ? new Promise<Event>(() => undefined)
      : Promise.resolve()
          .then(() => input.asker!.ask(card))
          .then(
            (answer): Event => ({ kind: "card", answer }),
            (error: unknown): Event => ({ kind: "card", answer: { decision: "cancel", reason: `the card could not be shown: ${String(error).slice(0, 200)}` } }),
          );
  const withdrawCard = async () => {
    if (!cardOpen || input.asker === undefined) return;
    cardOpen = false;
    await Promise.resolve(input.asker.withdraw(card.id)).catch(() => undefined);
  };
  /** The change's outcome now: `outcome` when this call closed it, else whatever closed it first. */
  const finalOf = (outcome: ChangeOutcome | undefined): ChangeOutcome => outcome ?? outcomeOf(deps.changes.get(id) ?? { ...record, state: "failed" });
  /** The card's answer came second: the outcome of the answer that came first, waiting for it while it applies. */
  const settled = async (): Promise<ChangeOutcome> => {
    const current = deps.changes.get(id);
    if (current !== undefined && !isOpen(current)) return outcomeOf(current);
    const event = await Promise.race([closed, ended]);
    if (event.kind === "closed") return event.outcome;
    return finalOf(closeOpenChange(answers, id, event.kind === "stop" ? "withdrawn" : "expired", event.kind === "stop" ? "stop" : undefined));
  };
  try {
    let waitingFor: Array<Promise<Event>> = [cardAnswer, closed, ended];
    for (;;) {
      const event = await Promise.race(waitingFor);
      if (event.kind === "closed") {
        // Answered elsewhere first (the Change page): the card closes as cancelled, the path a timeout takes.
        await withdrawCard();
        return resultOf(event.outcome, record, planned);
      }
      if (event.kind === "timeout") {
        await withdrawCard();
        return resultOf(finalOf(closeOpenChange(answers, id, "expired")), record, planned);
      }
      if (event.kind === "stop") {
        await withdrawCard();
        return resultOf(finalOf(closeOpenChange(answers, id, "withdrawn", "stop")), record, planned);
      }
      cardOpen = false;
      const { decision, reason } = event.answer;
      if (decision === "accept" || decision === "acceptForSession") {
        // "Opened it" on a change answered on the page: the call keeps waiting for the page.
        if (needsPage !== undefined) {
          waitingFor = [closed, ended];
          continue;
        }
        const answered = await answerOpenChange(answers, id, { by: "card", answerer: { kind: "card" }, action: "approve" });
        return resultOf(answered.ok ? answered.outcome : await settled(), record, planned);
      }
      if (decision === "decline") {
        const answered = await answerOpenChange(answers, id, { by: "card", answerer: { kind: "card" }, action: "decline" });
        return resultOf(answered.ok ? answered.outcome : await settled(), record, planned);
      }
      // A cancel: the owner's on the card; the card withdrawn by the caller's Stop, turn end or going away (`stop`); or the
      // card closing otherwise (no live turn, the CLI's own wait).
      const closer = reason === undefined ? "card" : reason === "withdrawn" || reason === "the turn ended" ? "stop" : undefined;
      const withdrawn = closeOpenChange(answers, id, reason === "no answer in time" ? "expired" : "withdrawn", closer);
      return resultOf(finalOf(withdrawn), record, planned);
    }
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) input.signal?.removeEventListener("abort", onAbort);
    waiter.cancel();
  }
};

/** Why `caller` may not write now (plan D2, D3, D7's order up to the change itself), or undefined. */
const mayNotWrite = (deps: SettingsServerDeps, caller: OwnCaller): { readonly reason: string; readonly text: string } | undefined => {
  const access = mcpServersOf(deps.ops.store.load())[SETTINGS_SERVER];
  if (access === undefined || !access.enabled) return { reason: "off", text: OFF_MESSAGE };
  if (access.writes === false) return { reason: "read-only", text: READ_ONLY_REFUSAL };
  // Linked or unknown work reads only (plan D3): decided by the Environment from the thread, never by the agent.
  const link = caller.thread === undefined ? "unknown" : deps.link(caller.thread);
  if (link === "linked") return { reason: "linked", text: LINKED_REFUSAL };
  if (link !== "own") return { reason: "unknown-thread", text: UNKNOWN_REFUSAL };
  const modes = deps.modes(caller);
  if (modes === undefined) return { reason: "no-modes", text: NO_MODES_REFUSAL };
  if (modes.interactionMode === "plan") return { reason: "plan", text: PLAN_REFUSAL };
  return undefined;
};

/**
 * The read caps (M3 review, D16-style): every read counts toward `READ_CAP` per thread per hour, and a read that reaches
 * GitHub or an MCP server (`NETWORK_READS`) toward `NETWORK_READ_CAP` as well. `preview_skills` mints a GitHub App token
 * for any installed repository, so only a caller that may write may preview (the owner's decision). Undefined: the read
 * runs, and is counted.
 */
/** Who reads, for the read caps: the caps' key (a thread, or an Owner client's `sub`), what the log names, and whether it may write. */
interface Reader {
  readonly key: string;
  /** "this thread" or "you", as a refusal names the reader. */
  readonly who: string;
  readonly log: Readonly<Record<string, unknown>>;
  readonly mayNotWrite: () => { readonly reason: string; readonly text: string } | undefined;
}

const ownReader = (deps: SettingsServerDeps, caller: OwnCaller): Reader => ({
  key: caller.thread ?? "unknown",
  who: "this thread",
  log: { door: caller.door, agent: caller.agent, thread: caller.thread ?? null },
  mayNotWrite: () => mayNotWrite(deps, caller),
});

/**
 * An asked change whose description reads GitHub (a skill's preview at a commit) spends a network read as
 * `preview_skills` does (SPI-1199 review): why not, past the cap, else undefined, and the read is counted.
 */
const networkSpent = (deps: SettingsServerDeps, reader: Reader): string | undefined => {
  const now = deps.ops.now();
  if (deps.changes.readsSince(reader.key, "network", now - READ_WINDOW_MS) >= NETWORK_READ_CAP) {
    return `Not changed: ${reader.who} made ${NETWORK_READ_CAP} reads that reach GitHub or an MCP server in the last hour, the most t3flare allows, and this change must preview its skills on GitHub. Try again later.`;
  }
  deps.changes.noteRead(reader.key, "network", now);
  return undefined;
};

const readLimit = (deps: SettingsServerDeps, reader: Reader, tool: string): McpCallAnswer | undefined => {
  const refused = (reason: string, text: string) => {
    deps.log?.({ t3flare: "settings-refused", via: "mcp", ...reader.log, tool, outcome: "refused", reason });
    return readError(text);
  };
  if (tool === "preview_skills") {
    const why = reader.mayNotWrite();
    if (why !== undefined) return refused(why.reason, `Not previewed: only a caller that may change the skills previews them. ${why.text}`);
  }
  const key = reader.key;
  const now = deps.ops.now();
  const network = NETWORK_READS.has(tool);
  if (deps.changes.readsSince(key, "read", now - READ_WINDOW_MS) >= READ_CAP) return refused("read-cap", `Not read: ${reader.who} made ${READ_CAP} settings reads in the last hour, the most t3flare allows. Try again later.`);
  if (network && deps.changes.readsSince(key, "network", now - READ_WINDOW_MS) >= NETWORK_READ_CAP) {
    return refused("network-read-cap", `Not read: ${reader.who} made ${NETWORK_READ_CAP} reads that reach GitHub or an MCP server in the last hour, the most t3flare allows. Try again later.`);
  }
  deps.changes.noteRead(key, network ? "network" : "read", now);
  return undefined;
};

const write = async (deps: SettingsServerDeps, input: SettingsCallInput): Promise<McpCallAnswer> => {
  const { caller, tool, args } = input;
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    deps.log?.({ t3flare: outcome === "applied" || outcome === "unchanged" ? "settings-change" : "settings-refused", via: "mcp", door: caller.door, agent: caller.agent, thread: caller.thread ?? null, tool, outcome, ...extra });
  const refuse = (reason: string, why: string, extra: Readonly<Record<string, unknown>> = {}) => {
    log("refused", { reason });
    return written("refused", why, extra);
  };
  const barred = mayNotWrite(deps, caller);
  if (barred !== undefined) return refuse(barred.reason, barred.text);
  const modes = deps.modes(caller)!;
  const planned = planWrite(deps, tool, args);
  if ("refused" in planned) return refuse("invalid", `Not changed: ${scrubText(planned.refused)}`);
  const expected = args.expectedRevision;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) return refuse("invalid", "Not changed: expectedRevision is the revision you read, a whole number.");
  const current = revisionOf(deps, planned.entity);
  if (expected !== current) {
    log("moved", { revision: current });
    return written("moved", `Not changed: the ${planned.entity === "harness" ? "Harness" : "Environment"} settings are at revision ${current}, not ${expected}; read them again.`, { revision: current });
  }
  // Only `free` and `unchanged` are named; anything else is asked (M1 review: `tierOf` may answer `unchanged`).
  if (planned.verdict.tier === "unchanged") {
    log("unchanged");
    return written("unchanged", `Nothing to change: the settings already say so (revision ${current}).`, { revision: current });
  }
  const key = caller.thread!;
  // An asked change always asks, in every mode (plan D7): an Open change, answered on the card or the Change page.
  if (planned.verdict.tier !== "free") return ask(deps, input, planned, expected, key);
  const now = deps.ops.now();
  if (deps.changes.appliedSince(key, now - APPLIED_WINDOW_MS) >= APPLIED_CAP) return refuse("applied-cap", `Not changed: this thread made ${APPLIED_CAP} settings changes in the last hour, the most t3flare allows. Try again later, or ask the owner.`);
  // The thread's mode (plan D7): full access runs a free change; any other mode asks the owner on one card.
  if (modes.runtimeMode !== "full-access") {
    if (input.asker === undefined) return refuse("no-asker", "Not changed: this thread's mode asks the owner for every write, and this call has no way to ask him.");
    const answer = await askOnCard(deps, input.asker, freeCard(input, planned, current), input.signal);
    if (answer.decision === "decline") {
      log("declined");
      return written("declined", "Not changed: the owner declined it.");
    }
    if (answer.decision !== "accept" && answer.decision !== "acceptForSession") {
      log("withdrawn", { reason: answer.reason ?? null });
      return written("withdrawn", `Not changed: the owner did not answer (${answer.reason ?? "cancelled"}).`);
    }
    // The card waited: the owner may have switched the server off or read-only, or the thread's mode moved, meanwhile
    // (M3 review). The revision is checked by the op itself.
    const since = mayNotWrite(deps, caller);
    if (since !== undefined) return refuse(since.reason, `Not changed: ${since.text}`);
  }
  const onCard = modes.runtimeMode !== "full-access";
  // A card-approved free change records how it was answered (ADR-0034 §11).
  const actor: AuditActor = { caller: `agent:${key}`, via: "mcp", thread: key, agent: caller.agent, tier: "free", ...(onCard ? { mode: "card" as const, answeredBy: "card" as const } : {}) };
  const ran = await planned.run({ actor, expectedRevision: expected });
  const revision = revisionOf(deps, planned.entity);
  if (!ran.ok) {
    if (ran.moved !== undefined) {
      log("moved", { revision: ran.moved });
      return written("moved", `Not changed: ${scrubText(ran.error)}`, { revision: ran.moved });
    }
    return refuse("invalid", `Not changed: ${scrubText(ran.error)}`);
  }
  if (ran.unchanged === true) {
    log("unchanged");
    return written("unchanged", `Nothing to change: the settings already say so (revision ${revision}).`, { revision });
  }
  deps.changes.recordApplied({
    id: newChangeId(),
    entity: planned.entity,
    expectedRevision: expected,
    tool,
    args: JSON.parse(canonicalJson(args)) as unknown,
    hash: await changeHash(tool, planned.normalized),
    tier: "free",
    caller: { door: "own", key, principal: "agent", thread: key, agent: caller.agent },
    createdAt: now,
    expiresAt: now,
    state: "applied",
    closed: { at: deps.ops.now(), revision },
  });
  log("applied", { tier: "free", entity: planned.entity, revision, asked: modes.runtimeMode !== "full-access" });
  return written("applied", `Applied: the ${planned.entity === "harness" ? "Harness" : "Environment"} settings are at revision ${revision}. ${planned.appliesAt}`, {
    revision,
    appliesAt: planned.appliesAt,
  });
};

/** One read tool's answer, for either door: `openKey` is the caller's key, whose Open changes `get_status` lists. */
const runRead = async (deps: SettingsServerDeps, name: string, args: Readonly<Record<string, unknown>>, actor: AuditActor, openKey: string | undefined): Promise<McpCallAnswer> => {
  switch (name) {
    case "get_settings":
      return getSettings(deps, args);
    case "list_mcp_servers":
      return listMcpServers(deps, args);
    case "list_skills":
      return listSkills(deps, args);
    case "get_status": {
      const access = mcpServersOf(deps.ops.store.load())[SETTINGS_SERVER];
      return read({
        status: deps.status?.() ?? {},
        access: { enabled: access?.enabled ?? false, writes: access?.writes ?? true },
        // This caller's Open changes (plan D8): its thread's, or its Access identity's.
        openChanges: openKey === undefined ? [] : deps.changes.openBy(openKey).map((record) => openChangeSummary(record, changeUrlOf(deps, record.id))),
      });
    }
    case "read_audit": {
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const before = typeof args.before === "number" ? args.before : undefined;
      return read(readAudit(deps.ops, { ...(limit === undefined ? {} : { limit }), ...(before === undefined ? {} : { before }) }));
    }
    case "test_mcp_server": {
      // No audit entry: a read through the server must not evict the log of changes (M3 review); the read cap bounds it.
      const tested = await testMcpServer(deps.ops, stringArg(args, "server") ?? "", { actor, audit: false });
      if (!tested.ok) return readError(tested.error);
      const { ok: _ok, ...shown } = tested;
      return readMcp(shown);
    }
    case "preview_skills":
      return skillsRead(deps, "/preview", { source: stringArg(args, "source") ?? "" }, actor);
    case "check_skill_updates":
      return skillsRead(deps, "/check", Array.isArray(args.names) ? { names: args.names } : {}, actor);
    default:
      return readError(`${name} is not a read tool of the Settings server`);
  }
};

/**
 * One call of the Settings server by t3flare's own agent (the MCP host's branch for kind `settings`). Its answer is the
 * host's: a result for the agent, or unavailable when the server is off.
 */
export const settingsCall = async (deps: SettingsServerDeps, input: SettingsCallInput): Promise<McpCallAnswer> => {
  const access = mcpServersOf(deps.ops.store.load())[SETTINGS_SERVER];
  if (access === undefined || !access.enabled) return { kind: "unavailable", message: OFF_MESSAGE, mayHaveRun: false };
  const tool = settingsToolOf(input.tool);
  if (tool === undefined) return { kind: "unavailable", message: `The Settings server has no tool ${input.tool}.`, mayHaveRun: false };
  if (tool.class === "write") return write(deps, input);
  const limited = readLimit(deps, ownReader(deps, input.caller), tool.name);
  if (limited !== undefined) return limited;
  const actor: AuditActor = { caller: input.caller.thread === undefined ? "agent" : `agent:${input.caller.thread}`, via: "mcp", ...(input.caller.thread === undefined ? {} : { thread: input.caller.thread }), agent: input.caller.agent };
  return runRead(deps, tool.name, input.args, actor, input.caller.thread);
};

// ── The Owner-client door (plan D11, D12; M5a, SPI-1200) ─────────────────────────────────────────────────────────
//
// The endpoint (endpoint.ts) reaches the same reads and the same planned writes as the own agents' door, through these
// entry points. An Owner client has no thread, no Linked work and no runtime mode (plan D7's last column): a read runs, a
// free change runs, and an asked change becomes an Open change in the client's Elicitation mode, which the endpoint
// then delivers (a page elicitation, or the link in the result) and which the Change page answers.

/** What an Owner client's call answered: a result now, or an Open change for the endpoint to deliver. */
export type OwnerCallAnswer =
  | { readonly kind: "result"; readonly answer: McpCallAnswer }
  | {
      readonly kind: "open";
      readonly record: ChangeRecord;
      /** The Change page's URL (`U`), when the host is known. */
      readonly url: string | undefined;
      /** The server-written text of the change (`M`): the card's text without the agent's call. */
      readonly message: string;
    };

export interface OwnerCallInput {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly caller: OwnerCaller;
  /** The Open change's mode: the request's Elicitation mode, after D12's fallbacks. */
  readonly mode: Exclude<ChangeMode, "card">;
}

const ownerReader = (deps: SettingsServerDeps, caller: OwnerCaller): Reader => ({
  key: caller.key,
  who: "you",
  log: { door: "owner", principal: caller.kind },
  mayNotWrite: () => {
    const access = mcpServersOf(deps.ops.store.load())[SETTINGS_SERVER];
    if (access === undefined || !access.enabled) return { reason: "off", text: OFF_MESSAGE };
    return access.writes === false ? { reason: "read-only", text: READ_ONLY_REFUSAL } : undefined;
  },
});

const ownerChangeCaller = (caller: OwnerCaller): ChangeCaller => ({
  door: "owner",
  key: caller.key,
  principal: caller.kind === "owner" ? "owner" : "service-token",
  ...(caller.client === undefined ? {} : { client: caller.client }),
});

/** The audit's caller for an Owner client (plan D15): `owner:<sub>`, or `service-token`. */
const ownerAuditCaller = (caller: OwnerCaller): string => (caller.kind === "owner" ? `owner:${caller.key}` : "service-token");

/** An Open change's message `M` (plan D12): the change as the server wrote it, who asked, and where it is answered. */
export const ownerMessage = (view: ChangeView, caller: Pick<OwnerCaller, "kind" | "client">): string =>
  cardText(
    [
      changeText(view),
      "",
      `Asked by ${askedByText({ door: "owner", principal: caller.kind === "owner" ? "owner" : "service-token", ...(caller.client === undefined ? {} : { client: caller.client }) })}.`,
      "Approve or decline it on the Change page.",
    ].join("\n"),
  );

/** The "waiting" result `W` (plan D12): the change waits for the owner at its page. `note` adds a fallback's reason. */
export const ownerWaiting = (record: Pick<ChangeRecord, "id">, url: string | undefined, note?: string): McpCallAnswer => {
  const where = url ?? "the Change page (its link is on the Harness panel's Open changes list)";
  return written(
    "waiting",
    `Waiting for the owner at ${where}. It applies when he approves it there. Do not repeat this call; read the settings to check.${note === undefined ? "" : ` ${note}`}`,
    { changeId: record.id, ...(url === undefined ? {} : { url }) },
  );
};

/** A closed Open change's result for an Owner client (plan D11's statuses). */
export const ownerOutcome = (outcome: ChangeOutcome, record: ChangeRecord): McpCallAnswer => resultOf(outcome, record, { appliesAt: record.shown?.appliesAt ?? "" });

/**
 * Withdraws an Owner client's Open change (a `decline` or `cancel` in its client's answer to the page elicitation, plan
 * D12): answers the change's outcome, which is the earlier one when something answered it first.
 */
export const withdrawOwnerChange = (deps: SettingsServerDeps, id: string): ChangeOutcome | undefined => closeOpenChange(answerDepsOf(deps), id, "withdrawn", "client");

/** An asked change from an Owner client (plan D8, D16): opened in `mode`, or the caller's same change already open. */
const ownerAsk = async (deps: SettingsServerDeps, input: OwnerCallInput, planned: Planned, expected: number): Promise<OwnerCallAnswer> => {
  const { caller, tool, args } = input;
  const now = deps.ops.now();
  const hash = await changeHash(tool, planned.normalized);
  const changeCaller = ownerChangeCaller(caller);
  const log = (event: string, extra: Record<string, unknown>) => deps.log?.({ t3flare: event, via: "mcp", door: "owner", principal: caller.kind, tool, ...extra });
  // A repeated call (a client that retried, or an agent that did not read `W`) finds its own change, not a second one.
  const reused = (): OwnerCallAnswer | undefined => {
    const same = deps.changes.openBy(caller.key).find((record) => record.state === "open" && record.hash === hash && record.expectedRevision === expected && record.mode === input.mode);
    return same?.shown === undefined ? undefined : { kind: "open", record: same, url: changeUrlOf(deps, same.id), message: ownerMessage(same.shown, caller) };
  };
  const first = reused();
  if (first !== undefined) return first;
  const capped = capRefusal(deps.changes, changeCaller, hash, now, openListOf(deps));
  if (capped !== undefined) {
    log("settings-refused", { outcome: "refused", reason: capped.reason });
    return { kind: "result", answer: written("refused", capped.text, { tier: "asked", reason: capped.reason, ...(capped.changeId === undefined ? {} : { changeId: capped.changeId }) }) };
  }
  const spent = planned.network === true ? networkSpent(deps, ownerReader(deps, caller)) : undefined;
  if (spent !== undefined) {
    log("settings-refused", { outcome: "refused", reason: "network-read-cap" });
    return { kind: "result", answer: written("refused", spent) };
  }
  const described = await planned.describe();
  if ("refused" in described) {
    log("settings-refused", { outcome: "refused", reason: "invalid" });
    return { kind: "result", answer: written("refused", `Not changed: ${scrubText(described.refused)}`) };
  }
  const view: ChangeView = { entity: planned.entity, subject: planned.subject, revision: expected, appliesAt: planned.appliesAt, reasons: planned.verdict.reasons, items: described.items, lines: described.lines };
  const id = newChangeId();
  const url = changeUrlOf(deps, id);
  const message = ownerMessage(view, caller);
  const needsPage = planned.verdict.needsPage ?? (visible(changeText(view)).length > CARD_TEXT_MAX ? "oversize" : undefined);
  const record: ChangeRecord = {
    id,
    entity: planned.entity,
    expectedRevision: expected,
    tool,
    args: JSON.parse(canonicalJson(args)) as unknown,
    hash,
    tier: "asked",
    shown: view,
    ...(needsPage === undefined ? {} : { needsPage }),
    mode: input.mode,
    caller: changeCaller,
    createdAt: now,
    expiresAt: now + CHANGE_TTL_MS,
    state: "open",
  };
  // The reuse and the caps again, in the same synchronous block as the insert (plan D16): the describe above awaited.
  const again = reused();
  if (again !== undefined) return again;
  const raced = capRefusal(deps.changes, changeCaller, hash, deps.ops.now(), openListOf(deps));
  if (raced !== undefined) {
    log("settings-refused", { outcome: "refused", reason: raced.reason });
    return { kind: "result", answer: written("refused", raced.text, { tier: "asked", reason: raced.reason, ...(raced.changeId === undefined ? {} : { changeId: raced.changeId }) }) };
  }
  deps.changes.insert(record);
  log("settings-change", { outcome: "open", change: id, tier: "asked", mode: input.mode, needsPage: needsPage ?? null });
  return { kind: "open", record, url, message };
};

/** An Owner client's write (plan D7's last column): the access switch, validation, the revision, the tier, the caps. */
const ownerWrite = async (deps: SettingsServerDeps, input: OwnerCallInput): Promise<OwnerCallAnswer> => {
  const { caller, tool, args } = input;
  const result = (answer: McpCallAnswer): OwnerCallAnswer => ({ kind: "result", answer });
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    deps.log?.({ t3flare: outcome === "applied" || outcome === "unchanged" ? "settings-change" : "settings-refused", via: "mcp", door: "owner", principal: caller.kind, tool, outcome, ...extra });
  const refuse = (reason: string, why: string) => {
    log("refused", { reason });
    return result(written("refused", why));
  };
  const barred = ownerReader(deps, caller).mayNotWrite();
  if (barred !== undefined) return refuse(barred.reason, barred.text);
  const planned = planWrite(deps, tool, args);
  if ("refused" in planned) return refuse("invalid", `Not changed: ${scrubText(planned.refused)}`);
  const expected = args.expectedRevision;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) return refuse("invalid", "Not changed: expectedRevision is the revision you read, a whole number.");
  const current = revisionOf(deps, planned.entity);
  if (expected !== current) {
    log("moved", { revision: current });
    return result(written("moved", `Not changed: the ${planned.entity === "harness" ? "Harness" : "Environment"} settings are at revision ${current}, not ${expected}; read them again.`, { revision: current }));
  }
  if (planned.verdict.tier === "unchanged") {
    log("unchanged");
    return result(written("unchanged", `Nothing to change: the settings already say so (revision ${current}).`, { revision: current }));
  }
  if (planned.verdict.tier !== "free") return ownerAsk(deps, input, planned, expected);
  const now = deps.ops.now();
  if (deps.changes.appliedSince(caller.key, now - APPLIED_WINDOW_MS) >= APPLIED_CAP) return refuse("applied-cap", `Not changed: you made ${APPLIED_CAP} settings changes in the last hour, the most t3flare allows. Try again later.`);
  const actor: AuditActor = { caller: ownerAuditCaller(caller), via: "mcp", ...(caller.client === undefined ? {} : { client: caller.client }), tier: "free" };
  const ran = await planned.run({ actor, expectedRevision: expected });
  const revision = revisionOf(deps, planned.entity);
  if (!ran.ok) {
    if (ran.moved !== undefined) {
      log("moved", { revision: ran.moved });
      return result(written("moved", `Not changed: ${scrubText(ran.error)}`, { revision: ran.moved }));
    }
    return refuse("invalid", `Not changed: ${scrubText(ran.error)}`);
  }
  if (ran.unchanged === true) {
    log("unchanged");
    return result(written("unchanged", `Nothing to change: the settings already say so (revision ${revision}).`, { revision }));
  }
  deps.changes.recordApplied({
    id: newChangeId(),
    entity: planned.entity,
    expectedRevision: expected,
    tool,
    args: JSON.parse(canonicalJson(args)) as unknown,
    hash: await changeHash(tool, planned.normalized),
    tier: "free",
    caller: ownerChangeCaller(caller),
    createdAt: now,
    expiresAt: now,
    state: "applied",
    closed: { at: deps.ops.now(), revision },
  });
  log("applied", { tier: "free", entity: planned.entity, revision });
  return result(written("applied", `Applied: the ${planned.entity === "harness" ? "Harness" : "Environment"} settings are at revision ${revision}. ${planned.appliesAt}`, { revision, appliesAt: planned.appliesAt }));
};

/**
 * One call of the Settings server by an Owner client (the Owner-client endpoint, plan D11). The endpoint has checked the
 * tool exists. Off answers every call refused, naming the panel; read-only refuses every write.
 */
export const settingsOwnerCall = async (deps: SettingsServerDeps, input: OwnerCallInput): Promise<OwnerCallAnswer> => {
  const access = mcpServersOf(deps.ops.store.load())[SETTINGS_SERVER];
  if (access === undefined || !access.enabled) {
    deps.log?.({ t3flare: "settings-refused", via: "mcp", door: "owner", principal: input.caller.kind, tool: input.tool, outcome: "refused", reason: "off" });
    return { kind: "result", answer: written("refused", OFF_MESSAGE) };
  }
  const tool = settingsToolOf(input.tool);
  if (tool === undefined) return { kind: "result", answer: readError(`The Settings server has no tool ${input.tool}.`) };
  if (tool.class === "write") return ownerWrite(deps, input);
  const limited = readLimit(deps, ownerReader(deps, input.caller), tool.name);
  if (limited !== undefined) return { kind: "result", answer: limited };
  const actor: AuditActor = { caller: ownerAuditCaller(input.caller), via: "mcp", ...(input.caller.client === undefined ? {} : { client: input.caller.client }) };
  return { kind: "result", answer: await runRead(deps, tool.name, input.args, actor, input.caller.key) };
};

/** Whether the Settings server lists `tool` to an Owner client now (plan D2's access switch): off lists none, read-only no write. */
export const ownerListed = (deps: Pick<SettingsServerDeps, "ops">): ((tool: { readonly class: ToolClass }) => boolean) => {
  const access = mcpServersOf(deps.ops.store.load())[SETTINGS_SERVER];
  if (access === undefined || !access.enabled) return () => false;
  return (tool) => tool.class === "read" || access.writes !== false;
};
