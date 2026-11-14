// Variables (SPI-1152, ADR-0032's Variables refinement): plain `NAME=value` pairs every command in a Workspace starts
// with, kept in the Environment settings. A Variable is agent-readable by definition, so it is never a credential
// (ADR-0016 A′): the refusals below are guard rails for the owner, not a boundary against him. Limits as cloudpid's
// (`@cloudpid/config`'s `container-settings.ts`, `variableNameProblem`).

/** The most Variables the Environment may have. */
export const MAX_VARIABLES = 50;

/** The longest name a Variable may have. */
export const MAX_VARIABLE_NAME_LENGTH = 128;

/** The longest value a Variable may have. */
export const MAX_VARIABLE_VALUE_LENGTH = 4096;

/** Names the shell or the Container sets for every command itself. */
export const REFUSED_EXACT: ReadonlyArray<string> = ["PATH", "HOME", "PWD", "SHELL", "USER"];

/** Prefixes another program keeps for itself, and why. */
export const REFUSED_PREFIXES: ReadonlyArray<{ readonly prefix: string; readonly owner: string }> = [
  { prefix: "T3", owner: "t3's and t3flare's own" },
  { prefix: "MISE_", owner: "mise's settings, which t3flare sets for every command" },
  { prefix: "GIT_", owner: "git's, which t3flare sets for every command" },
  { prefix: "GH_", owner: "the GitHub CLI's" },
  { prefix: "GITHUB_", owner: "GitHub's" },
  { prefix: "SSH_", owner: "ssh's" },
  { prefix: "LD_", owner: "the dynamic loader's" },
];

/** Names that make a program load code of the name's choosing before the command runs. */
export const REFUSED_LOADER_HOOKS: ReadonlyArray<string> = ["NODE_OPTIONS", "BASH_ENV", "ENV", "PROMPT_COMMAND"];

/** A segment of a name (between underscores, any case, singular or plural) that names a credential. */
export const CREDENTIAL_SEGMENTS: ReadonlyArray<string> = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"];

/** The segment of `name` that names a credential (as written, upper-cased), or undefined. */
export const credentialSegment = (name: string): string | undefined =>
  name
    .toUpperCase()
    .split("_")
    .find((part) => CREDENTIAL_SEGMENTS.some((word) => part === word || part === `${word}S`));

/** Whether `value` is a plain object, as a set of Variables is stored and sent. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The names t3flare already sets or pins that no rule above covers: in `COMMAND_ENV`, a CLI profile's environment or
 * Codex's shell policy, the managed settings' `env`, a Terminal's base environment or the shell variables its rc file
 * assigns. A Variable under one of them would be shadowed for some commands and not others, or redirect a CLI's
 * requests (`HTTPS_PROXY`). Derived from the code by `apps/environment/test/variableNames.test.ts`, which fails when one
 * of those sets a name this list misses, or this list keeps one nothing sets.
 */
export const SET_BY_T3FLARE: ReadonlyArray<string> = [
  "ALL_PROXY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_UNIX_SOCKET",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLAUDE_AGENT_ACP_EXPERIMENTAL_V2",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL",
  "CLAUDE_CODE_EXECUTABLE",
  "CLAUDE_CODE_MAX_RETRIES",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "DISABLE_AUTOUPDATER",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_FEEDBACK_COMMAND",
  "DISABLE_TELEMETRY",
  "DISABLE_UPDATES",
  "HISTFILE",
  "HISTFILESIZE",
  "HISTSIZE",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NO_PROXY",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_FREE_MODELS",
  "OPENCODE_DISABLE_LSP_DOWNLOAD",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_OFFLINE",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  "PS0",
  "PS1",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "http_proxy",
  "https_proxy",
];

/**
 * What looks like a credential in a value: cloudpid's `CREDENTIAL_PATTERNS` (cloudpid@47941c7c
 * `packages/extensions/src/skill-checks.ts`) without its two local-path patterns, each with what it looks like.
 */
export const CREDENTIAL_VALUE_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly looksLike: string }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/, looksLike: "an API key (sk-…)" },
  { pattern: /\bgh[pour]_[A-Za-z0-9]{30,}/, looksLike: "a GitHub token" },
  { pattern: /\bghs_[A-Za-z0-9._-]{36,}/, looksLike: "a GitHub installation token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}/, looksLike: "a GitHub personal access token" },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}/, looksLike: "a GitLab token" },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/, looksLike: "an npm token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, looksLike: "an AWS access key" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, looksLike: "a Slack token" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, looksLike: "a Google API key" },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, looksLike: "a signed token (JWT)" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, looksLike: "a private key" },
  { pattern: /\b(?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["'][A-Za-z0-9_+/=-]{20,}["']/i, looksLike: "an assigned key, token, secret or password" },
];

const SECRETS_STAY_OUT = "secrets never enter a Container (ADR-0016)";

/** Why `name` cannot be a Variable's, or undefined when it can. */
export const variableNameProblem = (name: string): string | undefined => {
  const quoted = JSON.stringify(name);
  if (name === "") return "a Variable's name may not be empty";
  if (name.length > MAX_VARIABLE_NAME_LENGTH) return `${quoted} is longer than ${MAX_VARIABLE_NAME_LENGTH} characters`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `${quoted} is not a name a shell can export: letters, digits and _, not starting with a digit`;
  if (REFUSED_EXACT.includes(name)) return `${quoted} is refused: the shell or the Container sets it for every command`;
  const prefix = REFUSED_PREFIXES.find((entry) => name.startsWith(entry.prefix));
  if (prefix !== undefined) return `${quoted} is refused: names starting ${prefix.prefix} are ${prefix.owner}`;
  if (REFUSED_LOADER_HOOKS.includes(name)) return `${quoted} is refused: it makes programs load code before a command runs`;
  const segment = credentialSegment(name);
  if (segment !== undefined) return `${quoted} is refused: its ${segment} part names a credential, and ${SECRETS_STAY_OUT}`;
  if (SET_BY_T3FLARE.includes(name)) return `${quoted} is refused: t3flare sets it itself, for every command or for a CLI agent`;
  return undefined;
};

/** Why `value` cannot be Variable `name`'s, or undefined when it can. */
export const variableValueProblem = (name: string, value: string): string | undefined => {
  const quoted = JSON.stringify(name);
  if (value.length > MAX_VARIABLE_VALUE_LENGTH) return `${quoted}'s value is longer than ${MAX_VARIABLE_VALUE_LENGTH} characters`;
  if (value.includes("\u0000")) return `${quoted}'s value holds a NUL character, which no environment can`;
  const credential = CREDENTIAL_VALUE_PATTERNS.find((entry) => entry.pattern.test(value));
  if (credential !== undefined) return `${quoted}'s value looks like ${credential.looksLike}, and ${SECRETS_STAY_OUT}`;
  return undefined;
};

/** Why `value` is not a set of Variables (`{ NAME: "value" }`), every problem named; undefined when it is one. */
export const variablesProblem = (value: unknown): string | undefined => {
  if (!isRecord(value)) return 'an object of Variables, { "NAME": "value" }';
  const entries = Object.entries(value);
  if (entries.length > MAX_VARIABLES) return `at most ${MAX_VARIABLES} Variables (${entries.length} given)`;
  const problems = entries.flatMap(([name, text]) => {
    const why = typeof text === "string" ? (variableNameProblem(name) ?? variableValueProblem(name, text)) : `${JSON.stringify(name)}'s value is not text`;
    return why === undefined ? [] : [why];
  });
  return problems.length === 0 ? undefined : problems.join("; ");
};

/**
 * The Variables of a stored set that still fit, in order, at most MAX_VARIABLES: a Variable a later rule refuses is
 * dropped alone, not the whole set. Anything that is not a set reads as none.
 */
export const fitVariables = (value: unknown): Readonly<Record<string, string>> => {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && variableNameProblem(entry[0]) === undefined && variableValueProblem(entry[0], entry[1]) === undefined)
      .slice(0, MAX_VARIABLES),
  );
};
