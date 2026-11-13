// Adapted from ian-pascoe/pi-extensions@a5e15d1:packages/pi-guardian/src/tool-policy.ts, safe-command.ts and
// sensitive-paths.ts (SPI-1058): which calls the Guardian reviews. Kept: the precedence (a `deny` Command Rule for a
// shell command, the configured Tool Policy, the built-in default, a read-only tool, else review), the allowed and
// reviewed tool lists, Safe Commands (literal words of the built-in programs joined by `|`, `&&`, `||`, `;`, with their
// argument checks and the two stderr redirects), Command Rules (longest prefix, wrappers, the quote-agnostic deny), and
// Sensitive Paths' names. Changed for the Durable agent:
// - The shell is the Workspace container's bash, with a fixed environment (no `shellPath`, no `GIT_*`, an absolute
//   `PATH`), so those environment checks have nothing to find.
// - No `cd` is a Safe Command segment: pi-guardian proves a `cd` harmless on the file system it runs on, which the
//   Session cannot see synchronously. A command with a `cd` is reviewed (pi-guardian's "when in doubt").
// - Sensitive Paths are judged lexically, against the Workspace's repo (`/workspace/repo`); symlinks, hard links and
//   Pi's own directories are not resolved (the Workspace has none of Pi's files).
// - Read-only tools come from t3flare's own knowledge (the MCP tools' classes, t3's annotations), not Pi annotations.
import { commandStarts, commandWords, looseCommands, safeRedirect, splitSegments, type Segments } from "./shell-syntax.ts";

export type ToolPolicy = "allow" | "review" | "deny";
export type PolicyEntries = Record<string, ToolPolicy>;

/** Which rule supplied a call's Tool Policy, in precedence order. */
export type ToolPolicySource = "command" | "setting" | "default" | "annotation" | "fallback";

export interface ResolvedToolPolicy {
  readonly policy: ToolPolicy;
  readonly source: ToolPolicySource;
  readonly detail?: string;
}

/** The read-only file tools. */
export const readOnlyBuiltIns: ReadonlyArray<string> = ["read", "grep", "find", "ls"];

/** Tools whose calls run without review by default (pi-guardian's list, with t3flare's own read-only and owner-asking tools). */
export const allowedByDefault: ReadonlyArray<string> = [
  ...readOnlyBuiltIns,
  "codemode",
  "tool_search",
  "todo",
  "web_search",
  "context_notes",
  "context_history",
  "context_rollover",
  "advisor_report",
  // t3flare: the owner answers it in t3; it reveals nothing.
  "ask_user",
  // pi-termctrl's read-only, closed-world tools (they carry `readOnlyHint` there).
  "terminal_list",
  "terminal_wait",
];
/** Tools reviewed by default regardless of their annotations. */
export const reviewedByDefault: ReadonlyArray<string> = ["terminal_start", "terminal_send", "powershell"];

const isFileWrite = (toolName: string): boolean => toolName === "edit" || toolName === "write";

// ── Safe Commands (safe-command.ts) ─────────────────────────────────────────────────────────────────────────────────

const shellSyntax = /[|&;<>()$`\\*?[\]{}!#^]/;
const doubleQuoteSyntax = /[$`\\!]/;
const tildePrefix = /[\s=:]/;
// oxlint-disable-next-line no-control-regex -- Control characters (including newlines) are exactly what this rejects.
const controlCharacters = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/;

/** Literal words as bash reads them; with `redirects`, `2>/dev/null` and `2>&1` standing alone are dropped. */
const lexWords = (command: string, redirects: boolean): Array<string> | undefined => {
  if (controlCharacters.test(command)) return undefined;
  const words: Array<string> = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index++) {
    const character = command[index] ?? "";
    if (quote) {
      if (character === quote) quote = undefined;
      else if (quote === '"' && doubleQuoteSyntax.test(character)) return undefined;
      else word = (word ?? "") + character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      word ??= "";
      continue;
    }
    if (character === " " || character === "\t") {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    if (redirects && word === undefined) {
      const redirect = safeRedirect.exec(command.slice(index));
      if (redirect) {
        index += redirect[0].length - 1;
        continue;
      }
    }
    if (shellSyntax.test(character)) return undefined;
    if (character === "~" && (index === 0 || tildePrefix.test(command[index - 1] ?? ""))) return undefined;
    word = (word ?? "") + character;
  }
  if (quote) return undefined;
  if (word !== undefined) words.push(word);
  return words.length > 0 ? words : undefined;
};

export const literalWords = (command: string): Array<string> | undefined => lexWords(command, false);

type ArgumentCheck = (args: ReadonlyArray<string>) => boolean;
const anyArguments: ArgumentCheck = () => true;
const rejectOptions =
  (...forbidden: Array<string>): ArgumentCheck =>
  (args) =>
    !args.some((arg) => forbidden.some((option) => arg === option || arg.startsWith(`${option}=`)));
const findActions = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const gitOutputOptions = rejectOptions("--output", "--ext-diff", "--textconv");
const gitBranchListing = new Set(["-a", "-r", "-v", "-vv", "-l", "--list", "--all", "--remotes", "--verbose", "--show-current", "--no-color", "--color"]);
const gitSubcommands = new Map<string, ArgumentCheck>([
  ["status", anyArguments],
  ["log", gitOutputOptions],
  ["diff", gitOutputOptions],
  ["show", gitOutputOptions],
  ["branch", (args) => args.every((arg) => gitBranchListing.has(arg))],
  ["rev-parse", anyArguments],
]);
const sedAddress = String.raw`(?:\d+|\$|/[^/\\\n\r]+/)`;
const sedPrintScript = new RegExp(String.raw`^${sedAddress}(?:,${sedAddress})?p$`);
const sedPrintOnly: ArgumentCheck = ([flag, script, ...files]) => flag === "-n" && script !== undefined && sedPrintScript.test(script) && !files.some((file) => file.startsWith("-"));

const builtInPrograms = new Map<string, ArgumentCheck>([
  ...["ls", "pwd", "cat", "head", "tail", "wc", "echo", "stat", "du", "df", "basename", "dirname", "realpath", "which", "whoami", "uname", "grep"].map(
    (name) => [name, anyArguments] as const,
  ),
  ["sed", sedPrintOnly],
  ["rg", rejectOptions("--pre", "--pre-glob", "--hostname-bin")],
  ["find", (args) => !args.some((arg) => findActions.has(arg))],
  [
    "git",
    ([subcommand, ...args]) => {
      const check = subcommand === undefined ? undefined : gitSubcommands.get(subcommand);
      return check ? check(args) : false;
    },
  ],
]);

const safeOperators = new Set(["|", "&&", "||", ";"]);

export interface MatchedCommandRule {
  readonly prefix: string;
  readonly policy: ToolPolicy;
}

const matchRule = (words: ReadonlyArray<string>, rules: Readonly<PolicyEntries>): MatchedCommandRule | undefined => {
  let best: { rule: MatchedCommandRule; length: number } | undefined;
  for (const [prefix, policy] of Object.entries(rules)) {
    const prefixWords = literalWords(prefix);
    if (prefixWords === undefined || prefixWords.length === 0 || prefixWords.length > words.length) continue;
    if (!prefixWords.every((word, index) => words[index] === word)) continue;
    if (best === undefined || prefixWords.length > best.length) best = { rule: { prefix, policy }, length: prefixWords.length };
  }
  return best?.rule;
};

/** Builtins that change the directory or run shell code that may (no `cd` is proved harmless here). */
const directoryChanges = new Set(["cd", "pushd", "popd", "source", ".", "eval"]);

const safeSegment = (segment: string, rule: MatchedCommandRule | undefined, lost: boolean): boolean => {
  const words = lexWords(segment, true);
  const program = words?.[0];
  if (words === undefined || program === undefined) return false;
  if (program.includes("=") || program.includes("/") || program === "") return false;
  if (rule?.policy === "allow") return true;
  // After a directory change only an `allow` rule permitted, `git` may read another repository's configuration.
  if (lost && program === "git") return false;
  const check = builtInPrograms.get(program);
  return check ? check(words.slice(1)) : false;
};

const safeSegments = ({ segments }: Segments, matched: ReadonlyArray<MatchedCommandRule | undefined>): boolean => {
  let lost = false;
  for (const [index, segment] of segments.entries()) {
    if (!safeSegment(segment, matched[index], lost)) return false;
    if (directoryChanges.has(lexWords(segment, true)?.[0] ?? "")) lost = true;
  }
  return true;
};

export type CommandJudgment =
  | { readonly verdict: "allow" }
  | { readonly verdict: "review"; readonly rule: MatchedCommandRule | undefined }
  | { readonly verdict: "deny"; readonly rule: MatchedCommandRule };

/** pi-guardian's `judgeCommand`: `deny` anywhere denies, `review` reviews, else a Safe Command runs. */
export const judgeCommand = (command: string, rules: Readonly<PolicyEntries> = {}): CommandJudgment => {
  const split = splitSegments(command);
  const words = split.segments.map(commandWords);
  const candidates = [...words, ...looseCommands(command, split)].flatMap((candidate, index) =>
    commandStarts(candidate, false).flatMap((start) => {
      const rule = matchRule(candidate.slice(start), rules);
      return rule !== undefined && (index < words.length || rule.policy === "deny") ? [rule] : [];
    }),
  );
  const denied = candidates.find((rule) => rule.policy === "deny");
  if (denied !== undefined) return { verdict: "deny", rule: denied };
  const reviewed = candidates.find((rule) => rule.policy === "review");
  if (reviewed !== undefined) return { verdict: "review", rule: reviewed };
  const matched = words.map((segmentWords) => matchRule(segmentWords, rules));
  return split.operators.every((operator) => safeOperators.has(operator)) && safeSegments(split, matched) ? { verdict: "allow" } : { verdict: "review", rule: undefined };
};

// ── Sensitive Paths (sensitive-paths.ts), lexically against the repo ────────────────────────────────────────────────

export const REPO = "/workspace/repo";

const normalize = (path: string): string => {
  const out: Array<string> = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
};

const contextFileNames = new Set(["agents.md", "agents.override.md", "claude.md"]);
const persistenceNames = new Set([
  ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout",
  ".ssh", ".gnupg", ".aws", ".azure", ".config", ".gitconfig", ".git-credentials", ".npmrc", ".yarnrc", ".pypirc", ".netrc", ".docker", ".kube",
]);
const persistencePairs: ReadonlyArray<readonly [string, string]> = [
  [".local", "bin"],
  [".cargo", "bin"],
  ["library", "launchagents"],
];
const workspaceConfiguration: ReadonlyMap<string, string> = new Map([
  [".pi", "Pi configuration"],
  [".agents", "agent Skills and configuration"],
  [".claude", "agent configuration"],
  [".husky", "git hooks"],
  [".vscode", "editor tasks and settings"],
  [".idea", "editor run configurations"],
  [".yarnrc.yml", "package-manager configuration"],
  [".pnpmfile.cjs", "package-manager install hooks"],
]);

const quoted = (components: ReadonlyArray<string>) => JSON.stringify(components.join("/"));

const persistenceAt = (components: ReadonlyArray<string>, index: number): ReadonlyArray<string> | undefined => {
  const name = components[index]?.toLowerCase();
  if (name === undefined) return undefined;
  if (persistenceNames.has(name)) return components.slice(index, index + 1);
  const next = components[index + 1]?.toLowerCase();
  return persistencePairs.some(([first, second]) => first === name && second === next) ? components.slice(index, index + 2) : undefined;
};

const sensitiveComponent = (components: ReadonlyArray<string>): string | undefined => {
  for (const [index, component] of components.entries()) {
    const name = component.toLowerCase();
    if (name === ".git") return `version-control metadata (${quoted([component])})`;
    if (name.startsWith(".env")) return `a secret or environment file (${quoted([component])})`;
    const configuration = workspaceConfiguration.get(name);
    if (configuration !== undefined) return `${configuration} (${quoted([component])})`;
    if (name === ".github" && components[index + 1]?.toLowerCase() === "workflows") return `CI workflows (${quoted(components.slice(index, index + 2))})`;
    const persistent = persistenceAt(components, index);
    if (persistent !== undefined) return `a shell startup, credential, or persistence file (${quoted(persistent)}) that takes effect once linked or copied into the home directory`;
  }
  const last = components.at(-1);
  if (last !== undefined && contextFileNames.has(last.toLowerCase())) return `a context file the agent loads as instructions (${quoted([last])})`;
  return undefined;
};

/** Why changing `path` (absolute, or relative to `cwd`) is sensitive; undefined for an ordinary repo path. */
export const sensitivePathReason = (path: string, cwd: string = REPO): string | undefined => {
  const resolved = normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  if (resolved !== REPO && !resolved.startsWith(`${REPO}/`)) return `outside the workspace root (${JSON.stringify(resolved)})`;
  return sensitiveComponent(resolved === REPO ? [] : resolved.slice(REPO.length + 1).split("/"));
};

// ── Tool Policies (tool-policy.ts) ──────────────────────────────────────────────────────────────────────────────────

export interface ToolPolicyInput {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly configured: Readonly<PolicyEntries>;
  readonly commands: Readonly<PolicyEntries>;
  /** Whether the tool only reads and reaches nothing outside (an MCP read tool, a read-only t3 tool); undefined: unknown. */
  readonly readOnly: boolean | undefined;
}

const commandRulesNote = (rules: Readonly<PolicyEntries>): string | undefined => {
  const named = (policy: ToolPolicy) => Object.entries(rules).flatMap(([prefix, value]) => (value === policy ? [JSON.stringify(prefix)] : []));
  const denied = named("deny");
  const reviewed = named("review");
  const parts: Array<string> = [];
  if (denied.length > 0) parts.push(`the user denies commands starting with ${denied.join(", ")} (Command Rules)`);
  if (reviewed.length > 0) parts.push(`the user requires review of commands starting with ${reviewed.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : undefined;
};

const withCommandRules = (reason: string, rules: Readonly<PolicyEntries>): string => {
  const note = commandRulesNote(rules);
  return note === undefined ? reason : `${reason}; ${note}`;
};

const builtInDefault = (call: ToolPolicyInput): ResolvedToolPolicy | undefined => {
  const { toolName, input } = call;
  if (allowedByDefault.includes(toolName)) return { policy: "allow", source: "default" };
  if (reviewedByDefault.includes(toolName)) {
    // A poll types nothing (pi-termctrl's `terminal_send` without text or keys): it only reads the screen.
    if (toolName === "terminal_send" && (typeof input.text !== "string" || input.text === "") && (!Array.isArray(input.keys) || input.keys.length === 0)) {
      return { policy: "allow", source: "default" };
    }
    const rules = commandRulesNote(call.commands);
    return rules === undefined ? { policy: "review", source: "default" } : { policy: "review", source: "default", detail: rules };
  }
  if (isFileWrite(toolName)) {
    const path = input.path;
    if (typeof path !== "string") return { policy: "review", source: "default", detail: "the target path is not a string" };
    const reason = sensitivePathReason(path);
    return reason === undefined ? { policy: "allow", source: "default" } : { policy: "review", source: "default", detail: `Sensitive Path: ${reason}` };
  }
  if (toolName === "bash") {
    const command = input.command;
    const judged = typeof command === "string" ? judgeCommand(command, call.commands) : undefined;
    if (judged?.verdict === "allow") return { policy: "allow", source: "default" };
    const reason = judged?.verdict === "review" && judged.rule !== undefined ? `the user's Command Rule ${JSON.stringify(judged.rule.prefix)} requires review` : "not a Safe Command";
    return { policy: "review", source: "default", detail: withCommandRules(reason, call.commands) };
  }
  return undefined;
};

const shellCommandTools: ReadonlyArray<string> = ["bash", "terminal_start", "powershell"];

/** One call's Tool Policy, as pi-guardian resolves it. */
export const resolveToolPolicy = (call: ToolPolicyInput): ResolvedToolPolicy => {
  const command = shellCommandTools.includes(call.toolName) ? call.input.command : undefined;
  if (typeof command === "string") {
    const judged = judgeCommand(command, call.commands);
    if (judged.verdict === "deny") return { policy: "deny", source: "command", detail: `the user's Command Rule ${JSON.stringify(judged.rule.prefix)} denies this command` };
  }
  const configured = Object.hasOwn(call.configured, call.toolName) ? call.configured[call.toolName] : undefined;
  if (configured !== undefined) return { policy: configured, source: "setting" };
  const fallback = builtInDefault(call);
  if (fallback !== undefined) return fallback;
  if (call.readOnly === true) return { policy: "allow", source: "annotation" };
  return { policy: "review", source: "fallback" };
};

/**
 * The panel's `name=policy, …` text (pi-guardian's menu takes Command Rules typed this way) as entries; an invalid pair
 * is named in `errors` and skipped.
 */
export const parseEntries = (text: string): { readonly entries: PolicyEntries; readonly errors: ReadonlyArray<string> } => {
  const entries: PolicyEntries = {};
  const errors: Array<string> = [];
  for (const raw of text.split(/[,\n]/)) {
    const pair = raw.trim();
    if (pair === "") continue;
    const at = pair.lastIndexOf("=");
    const key = at === -1 ? "" : pair.slice(0, at).trim();
    const value = at === -1 ? "" : pair.slice(at + 1).trim().toLowerCase();
    if (key === "" || (value !== "allow" && value !== "review" && value !== "deny")) errors.push(pair);
    else entries[key] = value;
  }
  return { entries, errors };
};
