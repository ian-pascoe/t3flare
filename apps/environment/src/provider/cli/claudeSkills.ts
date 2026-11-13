// A picked Skill in a Claude Code message (SPI-1151 §3): t3's composer writes `$name`, which Claude Code over ACP would
// take as plain text. Stock's Claude adapter rewrites it (`planClaudeSkillDispatch`); the wrapper does the same before
// t3's ACP adapter sees the turn (`wrapCliAdapter`'s `rewriteTurnText`). A mention that opens the message becomes
// `/name rest`, which the ACP adapter sends alone as a native Slash command and Claude Code expands (R6, M0); any other
// becomes an inline `/name` with stock's note naming its `SKILL.md`, so the agent reads it. Nothing is embedded: Claude's
// Skills rely on its own expansion (arguments, `allowed-tools`).
import { SKILL_TOKEN_REGEX } from "@t3flare/skills";
import { fromWorkspace } from "@t3flare/workspace-client";
import * as Effect from "effect/Effect";

import { planClaudeSkillDispatch } from "../../../../../t3code/apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts";
import { type SkillsAccess, SkillsReadError } from "../skills.ts";

/** Stock's note after an inline `/name` (`ClaudeSkillDispatch.ts`), before the `SKILL.md` path and `]`. */
export const CLAUDE_SKILL_NOTE = "[The user invoked this skill. Follow the instructions at: ";

/** A Skill Claude Code can be pointed at: its name and its `SKILL.md` as the Container sees it. */
export interface ClaudeSkill {
  readonly name: string;
  readonly path: string;
}

/** `text` with its mentions of `skills` rewritten for Claude Code; as typed when it names none. */
export const claudeSkillText = (text: string, skills: ReadonlyArray<ClaudeSkill>): string => {
  const known = new Map(skills.map((skill) => [skill.name, skill]));
  const plan = planClaudeSkillDispatch(text, new Map(skills.map((skill) => [skill.name, { path: skill.path }])));
  if (plan === undefined) return text;
  // The only mention opens the message: Claude's native expansion, the rest its arguments.
  if (plan.leadingText === undefined) return plan.commandText;
  const noted = new Set<string>();
  return text
    .replace(SKILL_TOKEN_REGEX, (match, lead: string, name: string) => {
      const skill = known.get(name);
      if (skill === undefined) return match;
      if (noted.has(name)) return `${lead}/${name}`;
      noted.add(name);
      return `${lead}/${name} ${CLAUDE_SKILL_NOTE}${skill.path}]`;
    })
    .trimEnd();
};

/**
 * The wrapper's rewrite for Claude Code: the thread's Skills at Claude Code's roots, read from the Workspace DO afresh,
 * only for a message with a sigil. A Workspace that does not answer leaves the message as typed.
 */
export const claudeMentionRewrite =
  (access: SkillsAccess) =>
  (text: string, cwd: string | null): Effect.Effect<string> => {
    // t3's mention token takes any currency sign, not only `$`.
    if (cwd === null || !/\p{Sc}/u.test(text)) return Effect.succeed(text);
    const at = access.locate(cwd);
    if (at === undefined) return Effect.succeed(text);
    return Effect.tryPromise({ try: () => at.workspace.skills(at.inner, "claude"), catch: (cause) => new SkillsReadError({ message: "Cannot read the Workspace's skills", cause }) }).pipe(
      Effect.map((found) => claudeSkillText(text, found.skills.map((skill) => ({ name: skill.name, path: fromWorkspace(at.id, skill.filePath) })))),
      Effect.tapError((error) => Effect.logWarning("t3flare: the Workspace's skills could not be read; the message goes as typed", error)),
      Effect.orElseSucceed(() => text),
    );
  };
