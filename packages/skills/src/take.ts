// @effect-diagnostics globalTimers:off globalConsole:off
// A Workspace's take of the Environment skill set before an agent runs (SPI-1148, plan §4.2; SPI-1153): when the hash
// the Environment holds differs from the one the Workspace holds, the Workspace takes the set from the Environment and
// serves it read-only. Bounded, and it never fails what waits on it: a Workspace that does not answer in time, refuses
// the set, or predates the call keeps the set it holds, and the agent runs with that. A Pi Durable turn carries the
// hash to its Session, which runs this (`apps/agents` `SessionDO`); a CLI agent's process start and each of its turns
// run it on the Environment's side (`apps/environment` `provider/cli/environmentSkillsTake.ts`).

/** How long a turn's start waits for its Workspace to take a new set: a take of 8 MiB took 0.6 s, the Container's copy up to 5 s more. */
export const SKILLS_TAKE_MS = 10_000;

/** What a Workspace's take answers (`WorkspaceDO.takeEnvironmentSkills`), as far as a Session reads it. */
export interface TakeAnswer {
  readonly taken: boolean;
  readonly hash: string;
  readonly error?: string;
  readonly container?: unknown;
}

export interface SkillsTaker {
  takeEnvironmentSkills(hash: string): Promise<TakeAnswer>;
}

/** Has `workspace` take the set `hash`, at most `waitMs`; logs what came of it, never throws. */
export const takeSkillsForTurn = async (hash: string | undefined, workspace: SkillsTaker | undefined, waitMs: number = SKILLS_TAKE_MS): Promise<TakeAnswer | "timeout" | "failed" | undefined> => {
  if (hash === undefined || workspace === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      workspace.takeEnvironmentSkills(hash),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), waitMs);
      }),
    ]);
    if (answer === "timeout") console.warn(JSON.stringify({ t3flare: "skills-take-timeout", hash: hash.slice(0, 12), waitMs }));
    else if (answer.error !== undefined) console.warn(JSON.stringify({ t3flare: "skills-take-refused", hash: hash.slice(0, 12), error: answer.error.slice(0, 300) }));
    else if (answer.taken) console.log(JSON.stringify({ t3flare: "skills-taken", hash: answer.hash.slice(0, 12), container: answer.container ?? null }));
    return answer;
  } catch (error) {
    console.warn(JSON.stringify({ t3flare: "skills-take-failed", hash: hash.slice(0, 12), error: String(error).slice(0, 300) }));
    return "failed";
  } finally {
    clearTimeout(timer);
  }
};
