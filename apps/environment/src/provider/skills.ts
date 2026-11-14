// Repo skills, Environment skills and Prompt templates on the Environment's side (SPI-1147 §3 and §4, SPI-1148 §4.4,
// SPI-1151): the composer's snapshot (`snapshotForCwd`) and the expansion of a message's Skill mentions and Slash
// commands (`turnPrompt`). Both ask the thread's Workspace DO for its Repo skills, which it finds in its own files and
// never starts the Container (ADR-0009). For Pi Durable they merge the Environment skills from this Environment's own
// rows, so a change shows at once (an Environment skill beats a Repo skill of its name), and are off with the Harness
// `skills` switch; a CLI agent's are at its own roots, with the Environment's rows merged by that CLI's own rule for a
// same-named pair (SPI-1153).
import type { ProviderDriverKind, ProviderInstanceId, ServerProvider, ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { ProviderWorkspaceSnapshot } from "@t3tools/provider-core/server/driver";
import { matchInlineSkills } from "@t3tools/shared/inlineSkills";
import {
  CLI_ROOTS,
  type CliAgent,
  type EnvironmentSkillEntry,
  environmentSkillPath,
  type PromptTemplate,
  type Skill,
  type SkillDiscovery,
  SKILLS_MOUNT,
  stripFrontmatter,
  substituteArgs,
  templateCall,
  withEnvironmentSkills,
  withEnvironmentSkillsFor,
} from "@t3flare/skills";
import { fromWorkspace, toWorkspace } from "@t3flare/workspace-client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { environmentServices } from "../agents/bindings.ts";
import { locate } from "../agents/workspaceClient.ts";

/** What the Environment asks of one Workspace for skills; paths inside it (`/workspace/repo/…`). `agent`: a CLI agent's roots (SPI-1151). */
export interface WorkspaceSkills {
  /** `repoOnly`: without the Environment skill set the Workspace holds (SPI-1148); an older Workspace ignores it. */
  readonly skills: (inner: string, agent?: CliAgent, options?: { readonly repoOnly?: boolean }) => Promise<SkillDiscovery>;
  readonly prompts: (inner: string, agent?: CliAgent) => Promise<ReadonlyArray<PromptTemplate>>;
  readonly readText: (inner: string) => Promise<string | null>;
}

/** The Environment skills from this Environment's rows (SPI-1148): the enabled ones, a `SKILL.md`, and the set's hash. */
export interface EnvironmentSkillRows {
  readonly entries: () => ReadonlyArray<EnvironmentSkillEntry>;
  readonly skillMd: (name: string) => string | undefined;
  readonly hash: () => string;
}

/** The switch, the Workspace a t3 path is in, and the Environment skills. */
export interface SkillsAccess {
  readonly enabled: () => boolean;
  readonly environment?: EnvironmentSkillRows;
  readonly locate: (cwd: string) => { readonly id: string; readonly inner: string; readonly workspace: WorkspaceSkills } | undefined;
}

/** The Environment's access: its harness switch, and the registry's Workspaces. */
export const environmentSkillsAccess = (): SkillsAccess => ({
  enabled: () => environmentServices().skillsEnabled(),
  environment: {
    entries: () =>
      environmentServices()
        .environmentSkills()
        .list()
        .filter((row) => row.enabled)
        .map(({ name, description, disableModelInvocation }) => ({ name, description, disableModelInvocation })),
    skillMd: (name) => environmentServices().environmentSkills().content(name, "SKILL.md"),
    hash: () => environmentServices().environmentSkills().hash(),
  },
  locate: (cwd) => {
    const located = locate(cwd);
    return located === undefined ? undefined : { id: located.id, inner: located.inner, workspace: located.rpc };
  },
});

/** The Workspace DO did not answer for its skills. */
export class SkillsReadError extends Schema.TaggedError<SkillsReadError, { readonly brand: unique symbol }>()("SkillsReadError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** `run`'s answer, its failure a `SkillsReadError`. */
const ask = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new SkillsReadError({ message: `Cannot read the Workspace's ${what}`, cause }) });

const trimmed = (text: string): string | undefined => (text.trim() === "" ? undefined : text.trim());

/** The Workspace's Repo skills with the Environment's rows merged first (plan §4.4): Pi Durable's. */
const mergedSkills = (at: { readonly inner: string; readonly workspace: WorkspaceSkills }, access: SkillsAccess): Promise<SkillDiscovery> =>
  at.workspace.skills(at.inner, undefined, { repoOnly: true }).then((repo) => withEnvironmentSkills(access.environment?.entries() ?? [], repo));

/**
 * A CLI agent's Skills (SPI-1151, SPI-1153): its Repo skills at its own roots with the Environment's rows merged by that
 * CLI's own rule for a same-named pair (`CLI_ROOTS[agent].environmentPrecedence`). The CLI reads the set through its
 * link (or pi's flag), so the rows are what it finds once its Workspace has taken them.
 */
export const cliSkills = (at: { readonly inner: string; readonly workspace: WorkspaceSkills }, access: SkillsAccess, agent: CliAgent): Promise<SkillDiscovery> =>
  at.workspace.skills(at.inner, agent).then((repo) => withEnvironmentSkillsFor(CLI_ROOTS[agent].environmentPrecedence, access.environment?.entries() ?? [], repo));

/** Whether `skill` is an Environment skill (its `SKILL.md` at the mount). */
const isEnvironmentSkill = (skill: Pick<Skill, "filePath">): boolean => skill.filePath.startsWith(`${SKILLS_MOUNT}/`);

/**
 * The composer's entries for a thread in `cwd`: its Repo skills and its Prompt templates; none outside a Workspace or
 * switched off. With `agent` (SPI-1151), a CLI agent's Repo skills and commands at its own roots, with the Environment
 * skills by that CLI's rule (SPI-1153), and not behind the Harness switch, which is Pi Durable's: the CLI loads them
 * whatever it says.
 */
export const workspaceComposerEntries = Effect.fn("PiDurable.workspaceComposerEntries")(function* (cwd: string, access: SkillsAccess, agent?: CliAgent) {
  const empty = { skills: [] as ReadonlyArray<ServerProviderSkill>, slashCommands: [] as ReadonlyArray<ServerProviderSlashCommand> };
  if (agent === undefined && !access.enabled()) return empty;
  const at = access.locate(cwd);
  if (at === undefined) return empty;
  const [discovery, templates] = yield* ask("skills", () => Promise.all([agent === undefined ? mergedSkills(at, access) : cliSkills(at, access, agent), at.workspace.prompts(at.inner, agent)]));
  const skills = discovery.skills.map((skill): ServerProviderSkill => {
    const description = trimmed(skill.description);
    return {
      name: skill.name,
      ...(description === undefined ? {} : { description }),
      // An Environment skill's path is the Workspace's mount, outside `/w/<id>`: t3's chip opens it as a project file and
      // shows its own read error (docs/upstream-fragility.md U64).
      path: fromWorkspace(at.id, skill.filePath),
      scope: isEnvironmentSkill(skill) ? "user" : "project",
      enabled: true,
      userInvocationOnly: skill.disableModelInvocation,
    };
  });
  const slashCommands = templates.map((template): ServerProviderSlashCommand => {
    const description = trimmed(template.description);
    const hint = template.argumentHint === undefined ? undefined : trimmed(template.argumentHint);
    return { name: template.name, ...(description === undefined ? {} : { description }), ...(hint === undefined ? {} : { input: { hint } }) };
  });
  return { skills, slashCommands };
});

/** `snapshotForCwd`: the machine snapshot with `cwd`'s composer entries. Freshness is t3's TTL. */
export const piDurableSnapshotForCwd = (machine: ServerProvider, cwd: string, access: SkillsAccess) =>
  Effect.map(workspaceComposerEntries(cwd, access), (entries): ProviderWorkspaceSnapshot => ({ ...machine, ...entries, slashCommandsPending: false }));

/**
 * A CLI agent's `snapshotForCwd` (SPI-1151): the machine snapshot with `cwd`'s Repo skills, and its repo commands after
 * the machine's built-ins (a built-in keeps its name). Read from the Workspace DO, never the Container. `repoCommands`
 * false lists none: OpenCode 2.2.7 over ACP ends a command's turn on submitting it, and its reply never reaches t3
 * (stage `pcli`, docs/steps/spi-1151.md).
 */
export const cliSnapshotForCwd = (machine: ServerProvider, cwd: string, access: SkillsAccess, agent: CliAgent, repoCommands = true) =>
  Effect.map(workspaceComposerEntries(cwd, access, agent), (entries): ProviderWorkspaceSnapshot => {
    const builtIn = new Set(machine.slashCommands.map((command) => command.name));
    return {
      ...machine,
      skills: entries.skills,
      slashCommands: [...machine.slashCommands, ...(repoCommands ? entries.slashCommands.filter((command) => !builtIn.has(command.name)) : [])],
      slashCommandsPending: false,
    };
  });

/** A CLI driver instance's `snapshotForCwd` over its machine snapshot (SPI-1151), failing as Pi Durable's does. */
export const cliSnapshotForCwdOf =
  (input: {
    readonly machine: Effect.Effect<ServerProvider>;
    readonly driver: ProviderDriverKind;
    readonly instanceId: ProviderInstanceId;
    readonly agent: CliAgent;
    readonly access?: SkillsAccess;
    readonly repoCommands?: boolean;
  }) =>
  (cwd: string): Effect.Effect<ProviderWorkspaceSnapshot, ProviderDriverError> => {
    const access = input.access ?? environmentSkillsAccess();
    return input.machine.pipe(
      Effect.flatMap((machine) => cliSnapshotForCwd(machine, cwd, access, input.agent, input.repoCommands ?? true)),
      Effect.mapError((cause) => new ProviderDriverError({ driver: input.driver, instanceId: input.instanceId, detail: "Failed to read the Workspace's skills.", cause })),
    );
  };

// ---------------------------------------------------------------------------------------------------------------------
// Expansion (§4): Skill mentions, a leading `/skill:name args` and a leading `/template args`

/** A thread's Skills and Prompt templates as a message expands with them, read fresh for each message that may. */
export interface MessageCatalog {
  readonly skills: ReadonlyArray<Skill>;
  readonly templates: ReadonlyArray<PromptTemplate>;
  /** A file's text, inside the Workspace; null when it cannot be read. */
  readonly read: (path: string) => Effect.Effect<string | null>;
  /** The block a Skill is embedded as; pi's (`skillBlock`) by default, OpenCode's for OpenCode (SPI-1151). */
  readonly block?: (skill: Pick<Skill, "name" | "filePath">, fileText: string) => string;
}

/** What `turnPrompt`'s caller passes to expand a message: Pi Durable's, and OpenCode's Skill mentions (SPI-1151). */
export interface MessageSkills {
  /** The catalog now; undefined when there is none (switched off, no Workspace, or the Workspace did not answer). */
  readonly load: () => Effect.Effect<MessageCatalog | undefined>;
}

/**
 * The thread in t3 path `cwd`'s skills, through `access`; read only when a message asks. With `opencode` (SPI-1151:
 * OpenCode is the one CLI agent whose adapter lacks an embed; Claude Code's is rejected): its Skills at OpenCode's
 * roots with the Environment skills by OpenCode's rule (SPI-1153: a Repo namesake wins), not behind the Harness switch
 * (Pi Durable's), with no Prompt templates (OpenCode's own commands reach it as typed), in t3 paths (the Container's),
 * as OpenCode's skill tool returns them.
 */
export const messageSkillsFor = (cwd: string | null | undefined, access: SkillsAccess, opencode = false): MessageSkills => ({
  load: Effect.fn("PiDurable.loadMessageSkills")(function* () {
    if (cwd === null || cwd === undefined || (!opencode && !access.enabled())) return undefined;
    const at = access.locate(cwd);
    if (at === undefined) return undefined;
    const workspace = at.workspace;
    const found = yield* ask("skills", () => (opencode ? Promise.all([cliSkills(at, access, "opencode"), Promise.resolve([])]) : Promise.all([mergedSkills(at, access), workspace.prompts(at.inner)]))).pipe(
      Effect.tapError((error) => Effect.logWarning("t3flare: the Workspace's skills could not be read; the message goes as typed", error)),
      Effect.option,
    );
    if (found._tag === "None") return undefined;
    const [discovery, templates] = found.value;
    const readInner = (path: string) => ask(path, () => workspace.readText(path)).pipe(Effect.orElseSucceed(() => null));
    // An Environment skill's `SKILL.md` is the Environment's row, current at once; the turn takes the set's hash first
    // (Pi Durable's Session, a CLI agent's wrapper), so its other files are in the Workspace before the agent reads them
    // (SPI-1148, SPI-1153).
    const read = (path: string) => {
      const name = discovery.skills.find((skill) => isEnvironmentSkill(skill) && skill.filePath === path && environmentSkillPath(skill.name) === path)?.name;
      const row = name === undefined ? undefined : access.environment?.skillMd(name);
      return row !== undefined ? Effect.succeed(row) : readInner(toWorkspace(path)?.inner ?? path);
    };
    if (!opencode) return { skills: discovery.skills, templates, read };
    // An Environment skill keeps its mount path (outside `/w/<id>`), which the Container reads too.
    return { skills: discovery.skills.map((skill) => ({ ...skill, filePath: fromWorkspace(at.id, skill.filePath) })), templates: [], read, block: opencodeSkillBlock };
  }),
});

/**
 * Whether `text` starts with a Slash command or holds a currency sigil (t3's mention token takes any `\p{Sc}`, not only
 * `$`): only then can it expand, so a plain message costs no lookup.
 */
export const hasCommandOrSigil = (text: string): boolean => text.startsWith("/") || /\p{Sc}/u.test(text);

/** `text` with its code (fenced blocks and inline spans) blanked, so a `$name` shown as code is not a mention. */
const withoutCode = (text: string): string => text.replace(/```[\s\S]*?(```|$)|`[^`\n]*`/g, (code) => " ".repeat(code.length));

const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

/** The block a Skill is embedded as, pi's and t3's Pi provider's (`mcpExtensionSource.ts`), from its `SKILL.md`'s text. */
export const skillBlock = (skill: Pick<Skill, "name" | "filePath">, fileText: string): string =>
  `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${directoryOf(skill.filePath)}.\n\n${stripFrontmatter(fileText).trim()}\n</skill>`;

/**
 * The block a Skill is embedded as for OpenCode: what OpenCode 2.2.7's own skill tool returns (`Skill.toModelOutput`,
 * `packages/core/src/skill.ts`), its body and its base directory, without the sampled file list.
 */
export const opencodeSkillBlock = (skill: Pick<Skill, "name" | "filePath">, fileText: string): string =>
  [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    stripFrontmatter(fileText).trim(),
    "",
    `Base directory for this skill: ${directoryOf(skill.filePath)}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "</skill_content>",
  ].join("\n");

/** `text` when it fits in `room` characters; else the bracketed note naming what was not embedded and its file. */
const fitOrNote = (text: string, room: number, budget: number, what: string, path: string): { readonly fits: string } | { readonly note: string } =>
  text.length <= room
    ? { fits: text }
    : { note: `[${what} is not embedded: it does not fit the message's ${budget.toLocaleString("en-US")}-character budget. Its file is ${path}.]` };

/**
 * `text` as the model gets it, within `budget` characters: a leading `/skill:name args` becomes the Skill's block and
 * its arguments, a leading `/template args` the template with pi's substitution, and each `$name` naming a Skill (t3's
 * `matchInlineSkills`, outside code) adds its block once, after the message. A name nothing knows is left as typed; a
 * file that does not fit is named in a bracketed note instead.
 */
export const expandMessage = Effect.fn("PiDurable.expandMessage")(function* (text: string, catalog: MessageCatalog, budget: number) {
  let base = text;
  const blocks: Array<string> = [];
  const notes: Array<string> = [];
  const seen = new Set<string>();
  const used = () => [base, ...blocks, ...notes].join("\n\n").length;
  /** The leading command's expansion as the message, or a note when it does not fit. */
  const lead = (expanded: string, what: string, path: string) => {
    const fit = fitOrNote(expanded, budget, budget, what, path);
    if ("fits" in fit) base = fit.fits;
    else notes.push(fit.note);
  };
  const command = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const leading = command === null ? undefined : catalog.skills.find((skill) => skill.name === command[1]);
  if (leading !== undefined) {
    const read = yield* catalog.read(leading.filePath);
    if (read !== null) {
      seen.add(leading.name);
      const args = (command?.[2] ?? "").trim();
      const block = (catalog.block ?? skillBlock)(leading, read);
      lead(args === "" ? block : `${block}\n\n${args}`, `Skill "${leading.name}"`, leading.filePath);
    }
  } else {
    const call = templateCall(text, catalog.templates);
    if (call !== undefined) {
      const read = yield* catalog.read(call.template.filePath);
      if (read !== null) lead(substituteArgs(stripFrontmatter(read), call.args), `Template "/${call.template.name}"`, call.template.filePath);
    }
  }
  for (const match of matchInlineSkills(withoutCode(text), catalog.skills)) {
    const skill = match.skill;
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    const read = yield* catalog.read(skill.filePath);
    if (read === null) continue;
    const fit = fitOrNote((catalog.block ?? skillBlock)(skill, read), budget - used() - 2, budget, `Skill "${skill.name}"`, skill.filePath);
    if ("fits" in fit) blocks.push(fit.fits);
    else notes.push(fit.note);
  }
  return [base, ...blocks, ...notes].join("\n\n");
});
