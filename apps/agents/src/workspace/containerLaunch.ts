// @effect-diagnostics globalTimers:off
// What a Workspace's Container starts with (SPI-1149, ADR-0032): the Environment settings, read from the Environment DO
// before a start with a bounded wait, as a Session reads the Harness settings at a turn's start; on no answer the copy
// the Workspace DO last kept, else the defaults. A start never waits on the Environment longer than the bound, and never
// omits `instance` (an omitted one starts `lite`).
import {
  type ContainerInstance,
  containerInstance,
  type ContainerSize,
  containerSizeOf,
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

/** The settings for the next Container start, and where they came from. Never fails. */
export const takeEnvironment = async (deps: TakeEnvironmentDeps): Promise<{ readonly settings: ResolvedEnvironment; readonly source: "environment" | "kept" | "default" }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      deps.read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), deps.waitMs);
      }),
    ]);
    if (answer !== undefined) {
      deps.keep(answer);
      return { settings: answer, source: "environment" };
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
  /** The Container budget carried with this start's lease request (the budget DO judges it, ADR-0032). */
  readonly budget: number;
  /** The Environment settings' revision it came from. */
  readonly revision: number;
}

/**
 * The launch for `settings`, resolved again against this Worker's schema: an Environment newer or older than this Worker
 * may answer a size or an idle time it does not know, which starts as the default.
 */
export const launchOf = (settings: ResolvedEnvironment): ContainerLaunch => {
  const resolved = resolveEnvironment({ revision: settings.revision, settings: { containerSize: settings.containerSize, containerIdleMinutes: settings.containerIdleMinutes, containerBudget: settings.containerBudget } });
  return {
    size: containerSizeOf(resolved.containerSize),
    instance: containerInstance(resolved.containerSize),
    idleMs: resolved.containerIdleMinutes * 60_000,
    budget: resolved.containerBudget,
    revision: resolved.revision,
  };
};
