// @effect-diagnostics globalDate:off globalTimers:off
// The Settings server (ADR-0034, plan D2, D3, D7, D14, D16, D17), pure over its deps: t3flare's own agents' door, M3
// (SPI-1198). The MCP host calls it for the `settings` entry of the MCP server set, before any inventory or pausing
// logic, with the caller the Environment derived (never one the agent states) and the call's asker.
//
// - Reads run for every caller, linked work included, and never carry a secret value, a fingerprint, a URL's query or an
//   authorization URL (D14).
// - A write is judged here, once (D7), in this order: the access switch; Linked or unknown work (D3); plan mode (and no
//   mode record); validation by the registry; the expected revision (D15); the Change tier (D5); the applied cap (D16);
//   then run, or ask the owner on one owner-only approval card on the calling thread. The Session's `mcp` extension and
//   the relay keep only the plan refusal for this server and raise no card of their own.
// - Interim, M3 only (D17): an asked change is refused, naming the Harness panel. Open changes, their card and the
//   Change page come in M4 (SPI-1199).
// - Every change goes through `ops.ts`, as the panel's do.
import {
  applyChange,
  applyEnvironmentChange,
  applyMcpChange,
  cardText,
  classOf,
  ENVIRONMENT_SETTINGS,
  EXTENSIONS,
  type HarnessChange,
  ignoredServersOf,
  type McpChange,
  mcpServersOf,
  PLAN_REFUSAL,
  resolveEnvironment,
  resolveHarness,
  SETTINGS_SERVER,
  type TierVerdict,
  tierOf,
  type ToolClass,
  withoutQuery,
} from "@t3flare/harness-registry";
import type { McpAsker, McpQuestionAnswer, McpQuestionCard } from "@t3flare/session-protocol";

import { containerCostTable } from "../harness/containerCost.ts";
import { changeEnvironment, changeExtension, changeMcp, changeSkills, type OpOptions, type OpsDeps, readAudit, testMcpServer } from "../harness/ops.ts";
import type { AuditActor } from "../harness/store.ts";
import { newCardId } from "../mcp/elicitation.ts";
import type { McpCallAnswer, McpHost } from "../mcp/host.ts";
import { viewSkill } from "../skills/api.ts";
import { APPLIED_CAP, APPLIED_WINDOW_MS, changeHash, newChangeId, type SettingsChanges } from "./changes.ts";
import { settingsToolOf } from "./tools.ts";

/** How long the owner's card waits (the MCP host's question wait, `QUESTION_WAIT_MS`). */
export const SETTINGS_CARD_WAIT_MS = 10 * 60_000;

/** A thread's Linked work as the Environment establishes it (plan D3). */
export type ThreadLink = "own" | "linked" | "unknown";

/** A calling thread's modes, from the Environment's own record (plan D3). */
export interface ThreadModes {
  readonly runtimeMode: string | undefined;
  readonly interactionMode: string | undefined;
}

/**
 * t3flare's own agent calling, as the Environment derived it (plan D3): its thread (undefined when the caller sent none:
 * judged as unknown work) and its agent kind (`piDurable`, or the CLI's name from the relay's tool handle).
 */
export interface OwnCaller {
  readonly door: "own";
  readonly thread: string | undefined;
  readonly agent: string;
}

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

/** The status every write's result carries (plan D11's `structuredContent`; `waiting` comes with M4). */
export type WriteStatus = "applied" | "unchanged" | "declined" | "withdrawn" | "moved" | "refused";

type Entity = "harness" | "environment";

export const LINKED_REFUSAL = "This thread is Linked work; the owner changes settings from his own thread, the Harness panel, or an Owner client.";
export const UNKNOWN_REFUSAL = "t3flare cannot establish where this thread comes from, so it may read settings and change none. The owner changes them from his own thread or the Harness panel.";
export const NO_MODES_REFUSAL = "t3flare has no record of this thread's modes (the Environment restarted during the turn), so it changes no settings now. Try again in the thread's next turn.";
export const OFF_MESSAGE = "The owner turned the Settings server off; only the Harness panel turns it back on.";
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

/** `value` with every string scrubbed and every `fingerprint` dropped, at any depth (plan D14). */
const scrub = (value: unknown): unknown => {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "fingerprint").map(([key, inner]) => [key, scrub(inner)]));
  return value;
};

/** A read's answer: what any reader but the panel may see. */
const read = (value: Readonly<Record<string, unknown>>): McpCallAnswer => {
  const shown = scrub(value);
  return { kind: "result", isError: false, text: json(shown), structured: shown };
};

const readError = (text: string): McpCallAnswer => ({ kind: "result", isError: true, text: scrubText(text) });

const written = (status: WriteStatus, text: string, extra: Readonly<Record<string, unknown>> = {}): McpCallAnswer => ({
  kind: "result",
  isError: status !== "applied" && status !== "unchanged",
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
  return read({
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

/** A write made ready: its entity, tier, and how it runs through the ops (absent: only the owner can apply it, M4). */
interface Planned {
  readonly entity: Entity;
  readonly appliesAt: string;
  readonly verdict: TierVerdict;
  readonly run?: (options: OpOptions) => Promise<{ readonly ok: true; readonly unchanged?: boolean } | { readonly ok: false; readonly error: string; readonly moved?: number }>;
}

type PlanOrRefusal = Planned | { readonly refused: string };

const fromOutcome = (outcome: { readonly ok: boolean; readonly error?: string; readonly status?: number; readonly revision?: number; readonly unchanged?: true }) =>
  outcome.ok
    ? { ok: true as const, ...(outcome.unchanged === true ? { unchanged: true } : {}) }
    : { ok: false as const, error: outcome.error ?? "refused", ...(outcome.status === 409 && outcome.revision !== undefined ? { moved: outcome.revision } : {}) };

const hintedClass = (deps: SettingsServerDeps) => (server: string, tool: string): ToolClass | undefined => {
  const definition = deps.ops.mcp.inventory(server).definitions[tool];
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
    entity: "harness",
    appliesAt: APPLIES_AT.harness,
    verdict: tierOf({ entity: "extension", stored, change }),
    run: async (options) => fromOutcome(changeExtension(deps.ops, change, options)),
  };
};

const planMcp = (deps: SettingsServerDeps, args: Readonly<Record<string, unknown>>): PlanOrRefusal => {
  const change = objectArg(args.change);
  if (change === undefined || typeof change.op !== "string" || typeof change.server !== "string") return { refused: "change is { op, server, … }" };
  const stored = deps.ops.store.load();
  const server = change.server;
  if (change.op === "header-value") {
    const setting = Object.hasOwn(mcpServersOf(stored), server) ? mcpServersOf(stored)[server] : undefined;
    if (setting === undefined || setting.kind !== "direct") return { refused: `No Direct server is named ${server}.` };
    if (setting.auth?.kind !== "header") return { refused: `${server} does not sign in with a header.` };
    // Its value is typed on the Change page alone (plan D6, M4): never applied through a tool.
    return { entity: "harness", appliesAt: APPLIES_AT.harness, verdict: tierOf({ entity: "mcp", stored, change: { op: "header-value", server } }) };
  }
  if (change.op !== "server" && change.op !== "class" && change.op !== "add" && change.op !== "remove") return { refused: "op is server, class, add, remove or header-value" };
  if (change.op === "add") {
    const auth = objectArg(change.auth);
    if (auth === undefined || (auth.kind !== "none" && auth.kind !== "header" && auth.kind !== "oauth")) return { refused: "auth.kind is none, header or oauth" };
    if (auth.kind === "header" && typeof auth.header !== "string") return { refused: "a header sign-in names its header" };
    if (typeof change.url !== "string") return { refused: "add needs the server's url" };
  }
  const mcpChange = change as unknown as McpChange;
  const applied = applyMcpChange(stored, mcpChange);
  if (!applied.ok) return { refused: applied.error };
  const verdict = tierOf({ entity: "mcp", stored, change: mcpChange, hintedClass: hintedClass(deps) });
  // A server is added on the Change page (M4): an add is always asked, and a header add takes its secret there.
  if (mcpChange.op === "add") return { entity: "harness", appliesAt: APPLIES_AT.harness, verdict };
  return { entity: "harness", appliesAt: APPLIES_AT.harness, verdict, run: async (options) => fromOutcome(changeMcp(deps.ops, mcpChange, options)) };
};

const planSignIn = (deps: SettingsServerDeps, args: Readonly<Record<string, unknown>>): PlanOrRefusal => {
  const server = stringArg(args, "server") ?? "";
  const stored = deps.ops.store.load();
  const setting = Object.hasOwn(mcpServersOf(stored), server) ? mcpServersOf(stored)[server] : undefined;
  if (setting === undefined || setting.kind !== "direct") return { refused: `No Direct server is named ${server}.` };
  if (setting.auth?.kind !== "oauth") return { refused: `${server} does not sign in with OAuth.` };
  // The sign-in starts in the owner's browser on the Change page (plan D6, O8): never through a tool.
  return { entity: "harness", appliesAt: APPLIES_AT.harness, verdict: tierOf({ entity: "mcp", stored, change: { op: "sign-in", server } }) };
};

const planEnvironment = (deps: SettingsServerDeps, args: Readonly<Record<string, unknown>>): PlanOrRefusal => {
  const settings = objectArg(args.settings);
  if (settings === undefined) return { refused: "settings is an object of Environment settings" };
  const stored = deps.ops.store.loadEnvironment();
  const applied = applyEnvironmentChange(stored, { settings });
  if (!applied.ok) return { refused: applied.error };
  return {
    entity: "environment",
    appliesAt: APPLIES_AT.environment,
    verdict: tierOf({ entity: "environment", stored, change: { settings } }),
    run: async (options) => fromOutcome(await changeEnvironment(deps.ops, settings, options)),
  };
};

const planSkills = (deps: SettingsServerDeps, args: Readonly<Record<string, unknown>>): PlanOrRefusal => {
  if (deps.ops.skills === undefined) return { refused: "The Environment skills are not available here." };
  const op = stringArg(args, "op");
  const name = stringArg(args, "name");
  const known = (wanted: string | undefined) => wanted !== undefined && deps.ops.skills?.store.get(wanted) !== undefined;
  const skillsRun =
    (route: "/install" | "/update" | "/remove" | "/enable", body: Record<string, unknown>) =>
    async (options: OpOptions): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string; readonly moved?: number }> => {
      const answer = await changeSkills(deps.ops, route, body, options);
      if (answer.status === 200) return { ok: true };
      const error = "text" in answer ? answer.text : json(answer.json);
      return answer.status === 409 ? { ok: false, error, moved: deps.ops.store.loadEnvironment().revision } : { ok: false, error };
    };
  const planned = (verdict: TierVerdict, run?: Planned["run"]): Planned => ({ entity: "environment", appliesAt: APPLIES_AT.skills, verdict, ...(run === undefined ? {} : { run }) });
  switch (op) {
    case "install": {
      const source = stringArg(args, "source");
      const commit = stringArg(args, "commit");
      if (source === undefined || commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) return { refused: "install names the source and the previewed 40-hex commit" };
      if (!Array.isArray(args.folders) || args.folders.length === 0 || !args.folders.every((folder) => typeof folder === "string")) return { refused: "install names at least one folder from the preview" };
      return planned(tierOf({ entity: "skills", change: { op: "install" } }), skillsRun("/install", { source, commit, folders: args.folders }));
    }
    case "update": {
      const commit = stringArg(args, "commit");
      if (!known(name)) return { refused: `No Environment skill is named ${name ?? ""}.` };
      if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) return { refused: "update names the 40-hex commit check_skill_updates answered" };
      return planned(tierOf({ entity: "skills", change: { op: "update", name: name! } }), skillsRun("/update", { name, commit }));
    }
    case "remove":
      if (!known(name)) return { refused: `No Environment skill is named ${name ?? ""}.` };
      return planned(tierOf({ entity: "skills", change: { op: "remove", name: name! } }), skillsRun("/remove", { name }));
    case "enable":
    case "disable": {
      if (!known(name)) return { refused: `No Environment skill is named ${name ?? ""}.` };
      const enabled = op === "enable";
      return planned(tierOf({ entity: "skills", change: { op: "enable", name: name!, enabled } }), skillsRun("/enable", { name, enabled }));
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

/** The owner-only approval card for a write the thread's mode asks about (plan D7, D9's card without the page). */
const writeCard = (input: SettingsCallInput, planned: Planned, revision: number): McpQuestionCard => {
  const thread = input.caller.thread ?? "an unknown thread";
  const prompt = [
    `An agent asks to change t3flare's ${planned.entity === "harness" ? "Harness" : "Environment"} settings (revision ${revision}):`,
    ...planned.verdict.reasons.map((reason) => `- ${reason}`),
    "",
    planned.appliesAt,
    `Asked by ${input.caller.agent} on thread ${thread}. This change is free (it narrows what agents have); this thread's mode asks for every write.`,
    "",
    `The agent's call: settings: ${input.tool}`,
    JSON.stringify(input.args, null, 2),
  ].join("\n");
  return {
    id: newCardId(),
    kind: "approval",
    server: SETTINGS_SERVER,
    title: cardText(`settings: ${input.tool}?`, 200),
    prompt: cardText(prompt),
    options: [
      { decision: "accept", label: "Approve" },
      { decision: "decline", label: "Decline" },
      { decision: "cancel", label: "Cancel" },
    ],
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

const write = async (deps: SettingsServerDeps, input: SettingsCallInput): Promise<McpCallAnswer> => {
  const { caller, tool, args } = input;
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    deps.log?.({ t3flare: outcome === "applied" || outcome === "unchanged" ? "settings-change" : "settings-refused", via: "mcp", door: caller.door, agent: caller.agent, thread: caller.thread ?? null, tool, outcome, ...extra });
  const refuse = (reason: string, why: string, extra: Readonly<Record<string, unknown>> = {}) => {
    log("refused", { reason });
    return written("refused", why, extra);
  };
  const access = mcpServersOf(deps.ops.store.load())[SETTINGS_SERVER];
  if (access?.writes === false) return refuse("read-only", READ_ONLY_REFUSAL);
  // Linked or unknown work reads only (plan D3): decided by the Environment from the thread, never by the agent.
  const link = caller.thread === undefined ? "unknown" : deps.link(caller.thread);
  if (link === "linked") return refuse("linked", LINKED_REFUSAL);
  if (link !== "own") return refuse("unknown-thread", UNKNOWN_REFUSAL);
  const modes = deps.modes(caller);
  if (modes === undefined) return refuse("no-modes", NO_MODES_REFUSAL);
  if (modes.interactionMode === "plan") return refuse("plan", PLAN_REFUSAL);
  const planned = planWrite(deps, tool, args);
  if ("refused" in planned) return refuse("invalid", `Not changed: ${planned.refused}`);
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
  if (planned.verdict.tier !== "free" || planned.run === undefined) {
    const url = deps.panelUrl();
    return refuse(
      "asked",
      [
        `Not changed: this change widens what agents have or can do, so it waits for the owner, and this version of t3flare cannot ask him from here yet.`,
        ...planned.verdict.reasons.map((reason) => `- ${reason}`),
        `Ask the owner to make it on the Harness panel${url === undefined ? "" : `: ${url}`}.`,
      ].join("\n"),
      { tier: "asked", reasons: planned.verdict.reasons, ...(url === undefined ? {} : { url }) },
    );
  }
  const key = caller.thread!;
  const now = deps.ops.now();
  if (deps.changes.appliedSince(key, now - APPLIED_WINDOW_MS) >= APPLIED_CAP) return refuse("applied-cap", `Not changed: this thread made ${APPLIED_CAP} settings changes in the last hour, the most t3flare allows. Try again later, or ask the owner.`);
  // The thread's mode (plan D7): full access runs a free change; any other mode asks the owner on one card.
  if (modes.runtimeMode !== "full-access") {
    if (input.asker === undefined) return refuse("no-asker", "Not changed: this thread's mode asks the owner for every write, and this call has no way to ask him.");
    const answer = await askOnCard(deps, input.asker, writeCard(input, planned, current), input.signal);
    if (answer.decision === "decline") {
      log("declined");
      return written("declined", "Not changed: the owner declined it.");
    }
    if (answer.decision !== "accept" && answer.decision !== "acceptForSession") {
      log("withdrawn", { reason: answer.reason ?? null });
      return written("withdrawn", `Not changed: the owner did not answer (${answer.reason ?? "cancelled"}).`);
    }
  }
  const actor: AuditActor = { caller: `agent:${key}`, via: "mcp", thread: key, agent: caller.agent, tier: "free" };
  const ran = await planned.run({ actor, expectedRevision: expected });
  const revision = revisionOf(deps, planned.entity);
  if (!ran.ok) {
    if (ran.moved !== undefined) {
      log("moved", { revision: ran.moved });
      return written("moved", `Not changed: ${ran.error}`, { revision: ran.moved });
    }
    return refuse("invalid", `Not changed: ${ran.error}`);
  }
  if (ran.unchanged === true) {
    log("unchanged");
    return written("unchanged", `Nothing to change: the settings already say so (revision ${revision}).`, { revision });
  }
  deps.changes.recordApplied({
    id: newChangeId(),
    entity: planned.entity,
    tool,
    args,
    hash: await changeHash(tool, args),
    tier: "free",
    caller: { door: "own", key, principal: "agent", thread: key, agent: caller.agent },
    createdAt: now,
    state: "applied",
    closed: { at: deps.ops.now(), revision },
  });
  log("applied", { tier: "free", entity: planned.entity, revision, asked: modes.runtimeMode !== "full-access" });
  return written("applied", `Applied: the ${planned.entity === "harness" ? "Harness" : "Environment"} settings are at revision ${revision}. ${planned.appliesAt}`, {
    revision,
    appliesAt: planned.appliesAt,
  });
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
  const actor: AuditActor = { caller: input.caller.thread === undefined ? "agent" : `agent:${input.caller.thread}`, via: "mcp", ...(input.caller.thread === undefined ? {} : { thread: input.caller.thread }), agent: input.caller.agent };
  switch (tool.name) {
    case "get_settings":
      return getSettings(deps, input.args);
    case "list_mcp_servers":
      return listMcpServers(deps, input.args);
    case "list_skills":
      return listSkills(deps, input.args);
    case "get_status":
      return read({
        status: deps.status?.() ?? {},
        access: { enabled: access.enabled, writes: access.writes ?? true },
        // Open changes come with M4 (SPI-1199): an asked change is refused now, so none is ever open.
        openChanges: [],
      });
    case "read_audit": {
      const limit = typeof input.args.limit === "number" ? input.args.limit : undefined;
      const before = typeof input.args.before === "number" ? input.args.before : undefined;
      return read(readAudit(deps.ops, { ...(limit === undefined ? {} : { limit }), ...(before === undefined ? {} : { before }) }));
    }
    case "test_mcp_server": {
      const tested = await testMcpServer(deps.ops, stringArg(input.args, "server") ?? "", { actor });
      if (!tested.ok) return readError(tested.error);
      const { ok: _ok, ...shown } = tested;
      return read(shown);
    }
    case "preview_skills":
      return skillsRead(deps, "/preview", { source: stringArg(input.args, "source") ?? "" }, actor);
    case "check_skill_updates":
      return skillsRead(deps, "/check", Array.isArray(input.args.names) ? { names: input.args.names } : {}, actor);
    default:
      return readError(`${tool.name} is not a read tool of the Settings server`);
  }
};
