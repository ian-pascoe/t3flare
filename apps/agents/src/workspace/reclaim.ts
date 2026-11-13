// Reclaiming room under the Container budget for a refused Container start (ADR-0032 §7). The budget may have been
// lowered below the running count, so one released lease may not be enough: idle holders are asked to stop only when enough of them are
// idle to bring the count under the budget, and otherwise none is. The idle ones are asked together, so a holder can turn
// busy between its check and its release only within one RPC; if one does, the others still stop and the start is
// refused (`enough: false`).

export interface ReclaimInput {
  /** The starting Workspace's own holder id: never counted or asked. */
  readonly self: string;
  /** The holders of the live leases, as the refusal named them. */
  readonly running: ReadonlyArray<string>;
  /** The budget the refusal was judged by. */
  readonly max: number;
  /** Whether a holder would give its lease up now (nothing runs there; `WorkspaceDO.reclaimable`). */
  readonly idle: (holder: string) => Promise<boolean>;
  /** Asks a holder to stop if it is still idle; whether it did (`WorkspaceDO.releaseIfIdle`). */
  readonly release: (holder: string) => Promise<boolean>;
}

/** The holders that stopped, and whether enough did for the start to fit under the budget. */
export const reclaimFor = async (input: ReclaimInput): Promise<{ readonly released: ReadonlyArray<string>; readonly enough: boolean }> => {
  const others = input.running.filter((holder) => holder !== input.self);
  const needed = others.length - input.max + 1;
  if (needed <= 0) return { released: [], enough: true };
  const idle: Array<string> = [];
  for (const holder of others) {
    if (idle.length >= needed) break;
    if (await input.idle(holder)) idle.push(holder);
  }
  if (idle.length < needed) return { released: [], enough: false };
  const outcomes = await Promise.all(idle.map(async (holder) => ((await input.release(holder)) ? [holder] : [])));
  const released = outcomes.flat();
  return { released, enough: released.length >= needed };
};
