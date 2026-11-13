// A picked Skill in a Claude Code message (SPI-1151 §3): t3's composer writes `$name`, which Claude Code over ACP would
// take as plain text. Stock's Claude adapter rewrites it (`planClaudeSkillDispatch`); the wrapper does the same before
// t3's ACP adapter sees the turn (`wrapCliAdapter`'s `rewriteTurnText`). A mention that opens the message becomes
// `/name rest`, which the ACP adapter sends alone as a native Slash command and Claude Code expands (R6, settled on stage
// pcli); every other mention becomes an inline `/name` with a note in stock's wording naming its `SKILL.md`, so the
// agent reads it. Stock notes only an earlier user-only Skill and sends the last mention as its own native block, which
// one ACP text cannot carry: here every mention but the opening one is noted, once per Skill. Nothing is embedded:
// Claude's Skills rely on its own expansion (arguments, `allowed-tools`).
import { SKILL_TOKEN_REGEX } from "@t3flare/skills";
import { fromWorkspace } from "@t3flare/workspace-client";
import * as Effect from "effect/Effect";

import { planClaudeSkillDispatch } from "../../../../../t3code/apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts";
import { type SkillsAccess, SkillsReadError } from "../skills.ts";

/** The note after an inline `/name`, in stock's wording (`ClaudeSkillDispatch.ts`), before the `SKILL.md` path and `]`. */
export const CLAUDE_SKILL_NOTE = "[The user invoked this skill. Follow the instructions at: ";

/** A Skill Claude Code can be pointed at: its name and its `SKILL.md` as the Container sees it. */
export interface ClaudeSkill {
  readonly name: string;
  readonly path: string;
}

/**
 * `text` with its mentions of `skills` rewritten for Claude Code; as typed when it names none. A mention that opens the
 * message is Claude's native `/name` (its rest the arguments, its later mentions noted); every other is noted, once.
 */
export const claudeSkillText = (text: string, skills: ReadonlyArray<ClaudeSkill>): string => {
  const known = new Map(skills.map((skill) => [skill.name, skill]));
  const plan = planClaudeSkillDispatch(text, new Map(skills.map((skill) => [skill.name, { path: skill.path }])));
  if (plan === undefined) return text;
  // The only mention opens the message: stock's native form.
  if (plan.leadingText === undefined) return plan.commandText;
  const noted = new Set<string>();
  // Where an opening mention's sigil would be: after the message's leading whitespace.
  const opening = text.length - text.trimStart().length;
  let opened = false;
  const rewritten = text.replace(SKILL_TOKEN_REGEX, (match, lead: string, name: string, offset: number) => {
    const skill = known.get(name);
    if (skill === undefined) return match;
    const first = !noted.has(name);
    noted.add(name);
    // The opening mention expands natively: a note would only repeat it.
    if (offset + lead.length === opening) {
      opened = true;
      return `${lead}/${name}`;
    }
    return first ? `${lead}/${name} ${CLAUDE_SKILL_NOTE}${skill.path}]` : `${lead}/${name}`;
  });
  // Only a native Slash command needs the message to start with it; any other text keeps its leading whitespace.
  return (opened ? rewritten.trimStart() : rewritten).trimEnd();
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
