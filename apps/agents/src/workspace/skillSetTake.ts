// A Workspace's take of the Environment skill set (SPI-1148, ADR-0033, plan §4.1-§4.2), apart from the Durable Object so
// it is tested with fakes (`test/skillSetTake.test.ts`); `WorkspaceDO.takeEnvironmentSkills` wires it to its storage,
// the Environment DO, computer's remount inside `blockConcurrencyWhile`, and its own `exec`.
import { skillSetProblem, SKILLS_MOUNT, type SkillSet } from "@t3flare/skills";
import { SKILLS_LOCK_FAILED } from "@t3flare/workspace-client";

import { type ContainerExpectation, expectationInput, expectationOf, parseWait, skillsWaitScript, type WaitAnswer } from "./skillSetWait.ts";

/** How many times the wait for a running Container's copy looks, 200 ms apart (plan §4.2: up to 5 s). */
export const SKILLS_WAIT_LOOKS = 25;

/** What a take answers: whether the set was taken, the hash held, why not, and the Container's copy. */
export interface TakeAnswer {
  readonly taken: boolean;
  readonly hash: string;
  readonly error?: string;
  /** A running Container's copy waited for, or `stopped` (none to wait for). */
  readonly container?: WaitAnswer | "stopped";
}

export interface TakeDeps {
  readonly store: {
    hash(): string;
    files(): Record<string, string>;
    refused(): { readonly hash: string; readonly message: string } | undefined;
    refuse(refusal: { readonly hash: string; readonly message: string }): void;
    clearRefused(): void;
  };
  /** The Environment's set (`environmentSkillSet`); an Environment that predates it rejects, and so does the take. */
  readonly read: () => Promise<unknown>;
  /** Keeps and mounts `set` with the fallback (`mountWithFallback` inside `blockConcurrencyWhile`). */
  readonly mount: (set: SkillSet) => Promise<{ readonly error?: string }>;
  /** Tells the Environment of a refusal (`skillSetRefused`); a failure is logged, never the take's. */
  readonly report: (hash: string, message: string) => Promise<void>;
  readonly awaitContainer: (expectation: ContainerExpectation) => Promise<WaitAnswer | "stopped" | undefined>;
  readonly warn: (line: string) => void;
}

/**
 * Takes the set when `hash` (the Environment's, carried by a turn) differs from the one held. A set refused before is
 * not read again until the hash moves. A set that is no set, or cannot be mounted, is refused, remembered, reported,
 * and the Workspace keeps what the mount fell back to. Then a running Container's copy is waited for.
 */
export const takeSkillSet = async (deps: TakeDeps, hash: string): Promise<TakeAnswer> => {
  const { store } = deps;
  const held = store.hash();
  if (hash === held) return { taken: false, hash: held };
  const refused = store.refused();
  if (refused?.hash === hash) return { taken: false, hash: held, error: refused.message };
  const refuse = async (refusedHash: string, message: string): Promise<TakeAnswer> => {
    store.refuse({ hash: refusedHash, message });
    deps.warn(JSON.stringify({ t3flare: "skills-refused", hash: refusedHash.slice(0, 12), message: message.slice(0, 300) }));
    await deps.report(refusedHash, message).catch((error: unknown) => deps.warn(JSON.stringify({ t3flare: "skills-refusal-unreported", error: String(error).slice(0, 200) })));
    return { taken: false, hash: store.hash(), error: message };
  };
  const set = await deps.read();
  const problem = skillSetProblem(set);
  if (problem !== undefined) {
    const declared = (set as { hash?: unknown } | null)?.hash;
    return refuse(typeof declared === "string" && declared !== "" ? declared : hash, `The Environment skill set was refused: ${problem}`);
  }
  const valid = set as SkillSet;
  if (valid.hash === held) return { taken: false, hash: held };
  const previous = store.files();
  const mounted = await deps.mount(valid);
  if (mounted.error !== undefined) return refuse(valid.hash, mounted.error);
  store.clearRefused();
  const container = await deps.awaitContainer(await expectationOf(previous, valid.files));
  return { taken: true, hash: valid.hash, ...(container === undefined ? {} : { container }) };
};

/** One command as the wait sends it; `onlyIfRunning`, so it never starts a stopped Container. */
export interface WaitCommand {
  readonly script: string;
  readonly stdin: string;
  readonly cwd: string;
  readonly passive: true;
  readonly onlyIfRunning: true;
  readonly timeoutMs: number;
}

/**
 * A running Container's copy of a new set, waited for: nothing when nothing moved; `stopped`, with no command, when the
 * Container is not running; else one passive command that refuses to start one. The running check and the command's
 * send happen in the same tick (computer's connect would start a stopped Container and, after an eviction, renew its
 * lease and idle clock).
 */
export const awaitContainerCopy = async (
  deps: { readonly running: () => boolean; readonly exec: (command: WaitCommand) => Promise<{ readonly status: string; readonly stdout: string }>; readonly warn: (line: string) => void },
  expectation: ContainerExpectation,
): Promise<WaitAnswer | "stopped" | undefined> => {
  if (expectation.present.length === 0 && expectation.removed.length === 0) return undefined;
  if (!deps.running()) return "stopped";
  const result = await deps
    .exec({ script: skillsWaitScript(SKILLS_MOUNT, SKILLS_WAIT_LOOKS, SKILLS_LOCK_FAILED), stdin: expectationInput(expectation), cwd: "/workspace", passive: true, onlyIfRunning: true, timeoutMs: 15_000 })
    .catch((error: unknown) => ({ status: String(error).slice(0, 200), stdout: "" }));
  if (result.status === "not-running") return "stopped";
  const answer = parseWait(result.stdout);
  if (!answer.caughtUp) deps.warn(JSON.stringify({ t3flare: "skills-container-stale", looks: answer.looks, stale: answer.stale.slice(0, 20), status: result.status }));
  return answer;
};
