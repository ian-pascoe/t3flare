// When the Session's one alarm fires, and what it does then (SessionDO `#arm` and `alarm`).
//
// The alarm also sends the Session's pushes (ADR-0005, 2026-11-21 refinement). A Durable Object's subrequests count
// against the newest of its incoming requests not yet done, and in a Durable Object a request stays not done while any
// of the object's work is pending, until the next request arrives. A push sent from a timer therefore went out one level
// below the Environment's last call into the Session, and the Environment's calls during that push one level below it:
// two levels per round trip, until "Subrequest depth limit exceeded" failed every call the Environment made. An alarm
// is a request of its own, at the top of no chain, so a push sent from it starts again at the top.

/** The least time from now to the next housekeeping alarm (heartbeat, turn deadline, push retry). */
const HOUSEKEEPING_FLOOR_MS = 500;

export interface NextAlarm {
  /** When to arm the alarm; null to delete it. */
  readonly at: number | null;
  /**
   * When housekeeping is next due, if it is: an alarm before it only pushes. Not floored, so a push alarm sees an overdue
   * fixed-time candidate (a turn deadline, a push retry) as due however often pushes rearm the alarm. The heartbeat and
   * the kill retry are reckoned from each arming, so they still move with it, as before.
   */
  readonly housekeepingAt: number | undefined;
}

/** The alarm for a due push (now) and for the earliest housekeeping `candidates` (at least `HOUSEKEEPING_FLOOR_MS` away). */
export const nextAlarm = (now: number, input: { readonly pushDue: boolean; readonly candidates: ReadonlyArray<number> }): NextAlarm => {
  const housekeepingAt = input.candidates.length === 0 ? undefined : Math.min(...input.candidates);
  if (input.pushDue) return { at: now, housekeepingAt };
  return { at: housekeepingAt === undefined ? null : Math.max(now + HOUSEKEEPING_FLOOR_MS, housekeepingAt), housekeepingAt };
};

/**
 * What a firing alarm does. One armed for a push before housekeeping is due only pushes; any other (one armed before the
 * object restarted, which forgot both, or the constructor's fallback) keeps house, which pushes when one is due.
 */
export const alarmWork = (
  now: number,
  input: { readonly pushDue: boolean; readonly housekeepingAt: number | undefined },
): { readonly push: boolean; readonly housekeeping: boolean } => ({
  push: input.pushDue,
  housekeeping: !input.pushDue || (input.housekeepingAt !== undefined && now >= input.housekeepingAt),
});
