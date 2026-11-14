// A turn takes the Environment skill set (SPI-1148, plan §4.2): the turn carries the set's hash, and when it differs
// from the one the thread's Workspace holds, the Workspace takes the set before the agent runs. The bounded take is
// shared with the CLI agents' (SPI-1153), in `@t3flare/skills`.
export { SKILLS_TAKE_MS, type SkillsTaker, type TakeAnswer, takeSkillsForTurn } from "@t3flare/skills";
