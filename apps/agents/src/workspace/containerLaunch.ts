// @effect-diagnostics globalTimers:off
// What a Workspace's Container starts with (SPI-1149, ADR-0032): the Environment settings, read from the Environment DO
// before a start with a bounded wait, as a Session reads the Harness settings at a turn's start; on no answer the copy
// the Workspace DO last kept, else the defaults. A start never waits on the Environment longer than the bound, and never
// omits `instance` (an omitted one starts `lite`).
import {
  type ContainerInstance,
  containerInstance,
  type ContainerSize,
  EMPTY_ENVIRONMENT,
  type ResolvedEnvironment,
  resolveEnvironment,
} from "@t3flare/harness-registry";

/** How long a Container start waits for the Environment's settings before it starts with the ones it kept. */
export const ENVIRONMENT_READ_MS = 5_000;

export interface TakeEnvironmentDeps {
  /** The Environment DO's `environmentSettings()`. */
  readonly read: () => Promise<ResolvedEnvironment>;
  readonly kept: () => ResolvedEnvironment | undefined;
  readonly keep: (settings: ResolvedEnvironment) => void;
  readonly waitMs: number;
}

/** Settings for a start and where they came from: only an `environment` read is fresh. */
export interface TakenEnvironment {
  readonly settings: ResolvedEnvironment;
  readonly source: "environment" | "kept" | "default";
}

/**
 * The settings for the next Container start, and where they came from. Never fails. The Environment's answer is read
 * against this Worker's schema (an Environment newer or older than this Worker may answer a value it does not know, which
 * reads as its default), then kept.
 */
export const takeEnvironment = async (deps: TakeEnvironmentDeps): Promise<TakenEnvironment> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      deps.read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), deps.waitMs);
      }),
    ]);
    if (answer !== undefined) {
      const settings = resolveEnvironment({ revision: answer.revision, settings: answer });
      deps.keep(settings);
      return { settings, source: "environment" };
    }
  } catch {
    // The Environment DO failed: the kept copy below.
  } finally {
    clearTimeout(timer);
  }
  const kept = deps.kept();
  return kept === undefined ? { settings: resolveEnvironment(EMPTY_ENVIRONMENT), source: "default" } : { settings: kept, source: "kept" };
};

/** What one Container start launches with, kept while it runs: a running Container keeps its size and idle time. */
export interface ContainerLaunch {
  readonly size: ContainerSize;
  readonly instance: ContainerInstance;
  readonly idleMs: number;
  /**
   * The Container budget carried with this start's lease request (the budget DO judges it, ADR-0032): only from a fresh
   * read, so a kept copy or the defaults never overwrite the owner's newer budget in the budget DO.
   */
  readonly budget?: number;
  /** The Environment settings' revision it came from. */
  readonly revision: number;
}

/** The launch for the settings `taken` (`takeEnvironment`'s, already read against this Worker's schema). */
export const launchOf = ({ settings, source }: TakenEnvironment): ContainerLaunch => ({
  size: settings.containerSize,
  instance: containerInstance(settings.containerSize),
  idleMs: settings.containerIdleMinutes * 60_000,
  ...(source === "environment" ? { budget: settings.containerBudget } : {}),
  revision: settings.revision,
});
