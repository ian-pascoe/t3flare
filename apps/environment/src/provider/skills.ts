// Repo skills and Prompt templates for Pi Durable, on the Environment's side (SPI-1147 §3 and §4): the composer's
// snapshot (`snapshotForCwd`) and the expansion of a message's Skill mentions and Slash commands (`turnPrompt`). Both
// ask the thread's Workspace DO, which finds them in its own files and never starts the Container (ADR-0009); both are
// off with the Harness `skills` switch.
import type { ServerProvider, ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import type { ProviderWorkspaceSnapshot } from "@t3tools/provider-core/server/driver";
import { matchInlineSkills } from "@t3tools/shared/inlineSkills";
import { type PromptTemplate, type Skill, type SkillDiscovery, stripFrontmatter, substituteArgs, templateCall } from "@t3flare/skills";
import { fromWorkspace } from "@t3flare/workspace-client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { environmentServices } from "../agents/bindings.ts";
import { locate } from "../agents/workspaceClient.ts";

/** What the Environment asks of one Workspace for skills; paths inside it (`/workspace/repo/…`). */
export interface WorkspaceSkills {
  readonly skills: (inner: string) => Promise<SkillDiscovery>;
  readonly prompts: (inner: string) => Promise<ReadonlyArray<PromptTemplate>>;
  readonly readText: (inner: string) => Promise<string | null>;
}

/** The switch, and the Workspace a t3 path is in. */
export interface SkillsAccess {
  readonly enabled: () => boolean;
  readonly locate: (cwd: string) => { readonly id: string; readonly inner: string; readonly workspace: WorkspaceSkills } | undefined;
}

/** The Environment's access: its harness switch, and the registry's Workspaces. */
export const environmentSkillsAccess = (): SkillsAccess => ({
  enabled: () => environmentServices().skillsEnabled(),
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

/** The composer's entries for a thread in `cwd`: its Repo skills and its Prompt templates; none outside a Workspace or switched off. */
export const workspaceComposerEntries = Effect.fn("PiDurable.workspaceComposerEntries")(function* (cwd: string, access: SkillsAccess) {
  const empty = { skills: [] as ReadonlyArray<ServerProviderSkill>, slashCommands: [] as ReadonlyArray<ServerProviderSlashCommand> };
  if (!access.enabled()) return empty;
  const at = access.locate(cwd);
  if (at === undefined) return empty;
  const [discovery, templates] = yield* ask("skills", () => Promise.all([at.workspace.skills(at.inner), at.workspace.prompts(at.inner)]));
  const skills = discovery.skills.map((skill): ServerProviderSkill => {
    const description = trimmed(skill.description);
    return {
      name: skill.name,
      ...(description === undefined ? {} : { description }),
      path: fromWorkspace(at.id, skill.filePath),
      scope: "project",
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

// ---------------------------------------------------------------------------------------------------------------------
// Expansion (§4): Skill mentions, a leading `/skill:name args` and a leading `/template args`

/** A thread's Skills and Prompt templates as a message expands with them, read fresh for each message that may. */
export interface MessageCatalog {
  readonly skills: ReadonlyArray<Skill>;
  readonly templates: ReadonlyArray<PromptTemplate>;
  /** A file's text, inside the Workspace; null when it cannot be read. */
  readonly read: (path: string) => Effect.Effect<string | null>;
}

/** What `turnPrompt`'s caller passes to expand a message: on for Pi Durable, absent for the ACP flavors (SPI-1151). */
export interface MessageSkills {
  /** The catalog now; undefined when there is none (switched off, no Workspace, or the Workspace did not answer). */
  readonly load: () => Effect.Effect<MessageCatalog | undefined>;
}

/** The thread in t3 path `cwd`'s skills, through `access`; read only when a message asks. */
export const messageSkillsFor = (cwd: string | null | undefined, access: SkillsAccess): MessageSkills => ({
  load: Effect.fn("PiDurable.loadMessageSkills")(function* () {
      if (cwd === null || cwd === undefined || !access.enabled()) return undefined;
      const at = access.locate(cwd);
      if (at === undefined) return undefined;
      const workspace = at.workspace;
      const found = yield* ask("skills", () => Promise.all([workspace.skills(at.inner), workspace.prompts(at.inner)])).pipe(
        Effect.tapError((error) => Effect.logWarning("t3flare: the Workspace's skills could not be read; the message goes as typed", error)),
        Effect.option,
      );
      if (found._tag === "None") return undefined;
      const [discovery, templates] = found.value;
      return {
        skills: discovery.skills,
        templates,
        read: (path: string) => ask(path, () => workspace.readText(path)).pipe(Effect.orElseSucceed(() => null)),
      };
  }),
});

/** Whether `text` may hold a Skill mention or a Slash command at all, so a plain message costs no lookup. */
export const mayExpand = (text: string): boolean => text.startsWith("/") || /\p{Sc}/u.test(text);

/** `text` with its code (fenced blocks and inline spans) blanked, so a `$name` shown as code is not a mention. */
const withoutCode = (text: string): string => text.replace(/```[\s\S]*?(```|$)|`[^`\n]*`/g, (code) => " ".repeat(code.length));

const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

/** The block a Skill is embedded as, pi's and t3's Pi provider's (`mcpExtensionSource.ts`). */
export const skillBlock = (skill: Pick<Skill, "name" | "filePath">, body: string): string =>
  `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${directoryOf(skill.filePath)}.\n\n${body}\n</skill>`;

const overBudget = (what: string, path: string, budget: number): string =>
  `[${what} is not embedded: it does not fit the message's ${budget.toLocaleString("en-US")}-character budget. Its file is ${path}.]`;

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
  const lead = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const leading = lead === null ? undefined : catalog.skills.find((skill) => skill.name === lead[1]);
  if (leading !== undefined) {
    const read = yield* catalog.read(leading.filePath);
    if (read !== null) {
      seen.add(leading.name);
      const args = (lead?.[2] ?? "").trim();
      const block = skillBlock(leading, stripFrontmatter(read).trim());
      const expanded = args === "" ? block : `${block}\n\n${args}`;
      if (expanded.length <= budget) base = expanded;
      else notes.push(overBudget(`Skill "${leading.name}"`, leading.filePath, budget));
    }
  } else {
    const call = templateCall(text, catalog.templates);
    if (call !== undefined) {
      const read = yield* catalog.read(call.template.filePath);
      if (read !== null) {
        const expanded = substituteArgs(stripFrontmatter(read), call.args);
        if (expanded.length <= budget) base = expanded;
        else notes.push(overBudget(`Template "/${call.template.name}"`, call.template.filePath, budget));
      }
    }
  }
  for (const match of matchInlineSkills(withoutCode(text), catalog.skills)) {
    const skill = match.skill;
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    const read = yield* catalog.read(skill.filePath);
    if (read === null) continue;
    const block = skillBlock(skill, stripFrontmatter(read).trim());
    if (used() + 2 + block.length <= budget) blocks.push(block);
    else notes.push(overBudget(`Skill "${skill.name}"`, skill.filePath, budget));
  }
  return [base, ...blocks, ...notes].join("\n\n");
});
