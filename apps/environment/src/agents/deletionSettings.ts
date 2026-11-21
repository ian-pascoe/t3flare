// The Sweep's settings (ADR-0043 §2–3), apart from `deletion.ts` so the Environment DO's module graph stays small:
// the Grace and whether the Sweep purges, read from the Environment settings at each use.
import type { ResolvedEnvironment } from "@t3flare/harness-registry";

export const DAY_MS = 24 * 60 * 60_000;

/** The Grace as the Sweep reads it at each use, from the Environment settings as stored now. */
export interface SweepSettings {
  /** The Environment setting `sweepPurges`: off, the Sweep still marks, and purges nothing (ADR-0043 §4). */
  readonly purging: boolean;
  readonly graceMs: number;
  /** The Environment setting `graceDays`, as stored (the page's control shows it even when overridden). */
  readonly graceDays: number;
  /** A Stage's `T3FLARE_SWEEP_GRACE_MS` overrides the Grace's days (the page says so). */
  readonly overridden: boolean;
}

/** The Sweep's settings from the resolved Environment settings and a Stage's `T3FLARE_SWEEP_GRACE_MS`, if set and positive. */
export const sweepSettingsOf = (environment: Pick<ResolvedEnvironment, "sweepPurges" | "graceDays">, overrideMs: string | undefined): SweepSettings => {
  const override = Number(overrideMs);
  const overridden = overrideMs !== undefined && overrideMs !== "" && Number.isFinite(override) && override > 0;
  return { purging: environment.sweepPurges, graceMs: overridden ? override : environment.graceDays * DAY_MS, graceDays: environment.graceDays, overridden };
};
