// Prompt templates (SPI-1147 §1 and §4; ported from cloudpid@47941c7c `packages/extensions/src/prompt-templates.ts`):
// Markdown files in the thread's cwd's `.pi/prompts` whose Slash command expands into a message, its arguments filled
// in. Parsing and substitution follow pi (`core/prompt-templates.ts` and `utils/frontmatter.ts` of pi's coding agent,
// MIT, © 2025 Mario Zechner). Unlike cloudpid, only the cwd's `.pi/prompts` counts, as pi's project templates do: not
// `.agents/prompts` (cloudpid's convention) nor `.claude/commands`.
import { parse } from "yaml";

import type { CommandSource } from "./cliRoots.ts";
import { join, type SkillFiles, withoutTrailingSlashes } from "./discovery.ts";

/** A Prompt template as discovery lists it; its body is read when a message uses it. */
export interface PromptTemplate {
  /** The file's name without `.md`. */
  readonly name: string;
  /** The `description` frontmatter, or the body's first line cut to 60 characters. */
  readonly description: string;
  /** The `argument-hint` frontmatter, shown after the name: `<file> [focus]`. */
  readonly argumentHint?: string;
  /** The absolute path of its file, inside the Workspace. */
  readonly filePath: string;
}

/** A template with its body, the frontmatter removed. */
export type ParsedTemplate = PromptTemplate & { readonly content: string };

/** Where a directory's Prompt templates are. */
export const PROMPTS_DIRECTORY = ".pi/prompts";

/** The largest template file listed, in bytes. */
export const MAX_TEMPLATE_BYTES = 256 * 1024;

const MAX_TEMPLATES = 100;
const MAX_ENTRIES = 1000;
const DESCRIPTION_LINE = 60;

/** `content` split as pi's `parseFrontmatter` splits it: its frontmatter's YAML, if any, and its body. */
const splitFrontmatter = (content: string): { readonly yaml: string | undefined; readonly body: string } => {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const end = normalized.startsWith("---") ? normalized.indexOf("\n---", 3) : -1;
  return end === -1 ? { yaml: undefined, body: normalized } : { yaml: normalized.slice(4, end), body: normalized.slice(end + 4).trim() };
};

/** A Markdown file's body without its frontmatter, as a Skill's body is embedded. */
export const stripFrontmatter = (content: string): string => splitFrontmatter(content).body;

/** The template a file at `filePath` holds, or undefined when its frontmatter is not YAML (pi skips such a file). */
export const parseTemplate = (filePath: string, text: string): ParsedTemplate | undefined => {
  const { yaml, body } = splitFrontmatter(text);
  let fields: unknown = {};
  if (yaml !== undefined) {
    try {
      fields = parse(yaml) ?? {};
    } catch {
      return undefined;
    }
  }
  const record = typeof fields === "object" && fields !== null && !Array.isArray(fields) ? (fields as Readonly<Record<string, unknown>>) : {};
  let description = typeof record.description === "string" ? record.description : "";
  if (description === "") {
    const first = body.split("\n").find((line) => line.trim() !== "");
    if (first !== undefined) description = first.length > DESCRIPTION_LINE ? `${first.slice(0, DESCRIPTION_LINE)}...` : first;
  }
  const hint = record["argument-hint"];
  return {
    name: (filePath.split("/").at(-1) ?? "").replace(/\.md$/, ""),
    description,
    ...(typeof hint === "string" && hint !== "" ? { argumentHint: hint } : {}),
    filePath,
    content: body,
  };
};

/** A command's arguments, split as bash splits words: quotes group, and a quoted empty string is an argument. */
export const parseCommandArgs = (args: string): Array<string> => {
  const words: Array<string> = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (const char of args) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
};

/** `${N:-`, `${@:-` or `${ARGUMENTS:-` at the `$` it is tried at: a placeholder with a default, up to the next `}`. */
const DEFAULT_START = /\$\{(\d+|ARGUMENTS|@):-/y;
/** `${@:N}` or `${@:N:L}` at the `$` it is tried at. */
const SLICE = /\$\{@:(\d+)(?::(\d+))?\}/y;
/** `$N`, `$@` or `$ARGUMENTS` at the `$` it is tried at. */
const SIMPLE = /\$(ARGUMENTS|@|\d+)/y;

/**
 * `content` with its placeholders filled from `args`: `$1`… for one argument, `$@` and `$ARGUMENTS` for all,
 * `${N:-default}` (and `${@:-default}`, `${ARGUMENTS:-default}`) for a missing or empty one, `${@:N}` from the Nth on and
 * `${@:N:L}` for L of them. Only the template is substituted: an argument that holds `$1` is left as it is.
 */
export const substituteArgs = (content: string, args: ReadonlyArray<string>): string => {
  const all = args.join(" ");
  const argument = (n: string): string | undefined => args[Number.parseInt(n, 10) - 1];
  // A scan from each `$`, as `replace` with one regex of the three forms would match, but in linear time: that regex's
  // `${N:-[^}]*}` read to the end of the template from every `${N:-` when no `}` follows, quadratic in a run of them.
  let out = "";
  let copied = 0;
  // The first `}` at or after the last default's start; -1 once none is left.
  let close = content.indexOf("}");
  let at = content.indexOf("$");
  while (at !== -1) {
    let replacement: string | undefined;
    let end = at;
    DEFAULT_START.lastIndex = at;
    const withDefault = DEFAULT_START.exec(content);
    if (withDefault !== null && close !== -1) {
      const valueStart = DEFAULT_START.lastIndex;
      if (close < valueStart) close = content.indexOf("}", valueStart);
      if (close !== -1) {
        const target = withDefault[1] ?? "";
        const value = target === "@" || target === "ARGUMENTS" ? all : argument(target);
        replacement = value === undefined || value === "" ? content.slice(valueStart, close) : value;
        end = close + 1;
      }
    }
    if (replacement === undefined) {
      SLICE.lastIndex = at;
      const slice = SLICE.exec(content);
      if (slice !== null) {
        // `${@:0}` is `${@:1}`, as in bash, where the arguments start at 1.
        const start = Math.max(Number.parseInt(slice[1] ?? "0", 10) - 1, 0);
        replacement = (slice[2] === undefined ? args.slice(start) : args.slice(start, start + Number.parseInt(slice[2], 10))).join(" ");
        end = SLICE.lastIndex;
      }
    }
    if (replacement === undefined) {
      SIMPLE.lastIndex = at;
      const simple = SIMPLE.exec(content)?.[1];
      if (simple !== undefined) {
        replacement = simple === "ARGUMENTS" || simple === "@" ? all : (argument(simple) ?? "");
        end = SIMPLE.lastIndex;
      }
    }
    if (replacement === undefined) {
      at = content.indexOf("$", at + 1);
      continue;
    }
    out += content.slice(copied, at) + replacement;
    copied = end;
    at = content.indexOf("$", end);
  }
  return out + content.slice(copied);
};

/** The template whose Slash command `text` starts with, and the arguments after its name; undefined for other text. */
export const templateCall = <T extends { readonly name: string }>(
  text: string,
  templates: ReadonlyArray<T>,
): { readonly template: T; readonly args: ReadonlyArray<string> } | undefined => {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const template = match === null ? undefined : templates.find(({ name }) => name === match[1]);
  return template === undefined ? undefined : { template, args: parseCommandArgs(match?.[2] ?? "") };
};

/** `text` expanded when it starts with one of `templates`' Slash commands; undefined for other text. */
export const expandTemplate = (text: string, templates: ReadonlyArray<{ readonly name: string; readonly content: string }>): string | undefined => {
  const call = templateCall(text, templates);
  return call === undefined ? undefined : substituteArgs(call.template.content, call.args);
};

const byName = (a: { readonly name: string }, b: { readonly name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The Durable agent's (and pi's) Prompt templates: the cwd's `.pi/prompts`, its files only. */
const PI_PROMPTS: ReadonlyArray<CommandSource> = [{ directory: PROMPTS_DIRECTORY, nested: false }];

/**
 * The Prompt templates of a thread in `cwd`: the `.md` files directly in its `.pi/prompts`, in name order; or, with
 * `sources` (a CLI agent's commands, SPI-1151), in each of those directories, a nested file named `sub:name`, the first
 * name found winning. A file whose name holds whitespace is not one (its Slash command would end at the space), nor one
 * over `MAX_TEMPLATE_BYTES`.
 */
export const discoverPrompts = async (files: SkillFiles, cwd: string, sources: ReadonlyArray<CommandSource> = PI_PROMPTS): Promise<ReadonlyArray<PromptTemplate>> => {
  const base = withoutTrailingSlashes(cwd);
  const listed = await Promise.all(
    sources.map(async (source) => {
      const root = join(base, source.directory);
      const entries = await files.list(root, MAX_ENTRIES);
      return entries
        .filter((entry) => entry.kind !== "directory" && (source.nested || !entry.path.includes("/")) && !/\s/.test(entry.path) && entry.path.endsWith(".md"))
        // A nested source's dot directories (`.git`-like) hold no commands; a file's own name is not judged here.
        .filter((entry) => !entry.path.split("/").slice(0, -1).some((segment) => segment.startsWith(".")))
        .map((entry) => ({ path: join(root, entry.path), name: entry.path.replace(/\.md$/, "").replaceAll("/", ":") }))
        .sort(byName);
    }),
  );
  const seen = new Set<string>();
  const chosen = listed
    .flat()
    .filter((entry) => (seen.has(entry.name) ? false : (seen.add(entry.name), true)))
    .slice(0, MAX_TEMPLATES);
  const templates = await Promise.all(
    chosen.map(async (entry) => {
      const text = await files.read(entry.path);
      if (text === undefined || new TextEncoder().encode(text).length > MAX_TEMPLATE_BYTES) return undefined;
      const parsed = parseTemplate(entry.path, text);
      if (parsed === undefined) return undefined;
      const { content: _content, ...template } = parsed;
      return { ...template, name: entry.name };
    }),
  );
  return templates.filter((template) => template !== undefined).sort(byName);
};
