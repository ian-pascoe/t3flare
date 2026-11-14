// @effect-diagnostics globalDate:off
// Open changes (ADR-0034, plan D8, D16), M4 (SPI-1199): an asked Settings change waiting for its answer, kept in the
// changes table (changes.ts). This file holds what every door shares, pure over its deps:
//
// - the caps (D16), counted from the table, checked before a change is opened;
// - one answer (D8): `answerOpenChange` moves `open` to `applying` in the same synchronous block that checks expiry,
//   the answerer and the revision, so a second answer finds it closed; then it applies through the deps' `apply` (the
//   Settings server's, over `ops.ts`) with the expected revision, and closes the record. A moved revision closes it as
//   `moved` and applies nothing;
// - closing without an answer (`closeOpenChange`: withdrawn, expired);
// - the in-memory waiters a held call waits on. With no waiter (after an Environment restart the call is gone), the
//   record still stands until it expires, and the Change page can still apply it.
import {
  type AnsweredBy,
  APPLIED_CAP,
  APPLIED_WINDOW_MS,
  type ChangeCaller,
  type ChangeRecord,
  type ChangeState,
  CLOSED_KEPT_MS,
  type ClosedBy,
  closedLine,
  durationText,
  isOpen,
  type SettingsChanges,
  STRIKE_LOCK_MS,
  STRIKE_WINDOW_MS,
} from "./changes.ts";

/** Open changes per own-agent thread (plan D16): a second asked call is refused, not queued. */
export const OPEN_PER_THREAD = 1;
/** Open changes per Owner `sub`. */
export const OPEN_PER_OWNER = 2;
/** Open changes across the Environment: a storage bound. */
export const OPEN_ACROSS = 16;
/** The same change (by hash) after a decline, per caller, is refused this long. */
export const DECLINED_REPEAT_MS = 10 * 60_000;
/**
 * This many in a row declined (or, for own agents, unanswered), within `STRIKE_WINDOW_MS` of each other, refuse the
 * caller's asked changes for `STRIKE_LOCK_MS` from the last of them.
 */
export const STRIKES = 3;

/** A closed change's outcome, as a held call and an answerer read it. Never an authorization URL. */
export interface ChangeOutcome {
  readonly state: ChangeState;
  readonly revision?: number;
  readonly error?: string;
  readonly by?: ClosedBy;
}

/** A cap's refusal: why, in words for the agent, and the open change it names when one is open. */
export interface CapRefusal {
  readonly reason: "open-thread" | "open-owner" | "open-across" | "declined-repeat" | "strikes" | "applied-cap";
  readonly text: string;
  readonly changeId?: string;
}

/**
 * Why `caller` may not open an asked change of `hash` now (plan D16), or undefined. `openList` is the panel's Open
 * changes list, named by the Environment-wide cap's refusal.
 */
export const capRefusal = (changes: SettingsChanges, caller: ChangeCaller, hash: string, now: number, openList?: string): CapRefusal | undefined => {
  const mine = changes.openBy(caller.key);
  const perCaller = caller.door === "own" ? OPEN_PER_THREAD : OPEN_PER_OWNER;
  if (mine.length >= perCaller) {
    const [first] = mine;
    return {
      reason: caller.door === "own" ? "open-thread" : "open-owner",
      text:
        caller.door === "own"
          ? `Not changed: this thread already has a change waiting for the owner (${first!.id}); ask for one at a time. Wait for its answer, or read get_status.`
          : `Not changed: ${perCaller} changes of yours already wait for an answer (${mine.map((record) => record.id).join(", ")}); answer or cancel one first.`,
      changeId: first!.id,
    };
  }
  if (changes.open().length >= OPEN_ACROSS) {
    return { reason: "open-across", text: `Not changed: ${OPEN_ACROSS} changes already wait for the owner across this Environment, the most t3flare keeps. He sees them on the Harness panel's Open changes list${openList === undefined ? "" : `: ${openList}`}.` };
  }
  const recent = changes.closedBy(caller.key, now - STRIKE_WINDOW_MS - STRIKE_LOCK_MS);
  if (recent.some((record) => record.hash === hash && record.state === "declined" && record.closed!.at > now - DECLINED_REPEAT_MS)) {
    return { reason: "declined-repeat", text: `Not changed: the owner declined this same change less than ${durationText(DECLINED_REPEAT_MS)} ago. Do not ask again; ask him in the thread what he wants instead.` };
  }
  // A strike is a decline; for own agents an expiry too (unanswered), never for an Owner client (a dropped stream or an
  // expiry is not one). A withdrawn or moved change neither strikes nor breaks the run; an applied one breaks it.
  const strike = (record: ChangeRecord) => record.state === "declined" || (caller.door === "own" && record.state === "expired");
  // The lock runs from the last strike of the run (plan D16: refused for an hour after the third).
  const run = recent.filter((record) => record.state === "applied" || strike(record)).slice(0, STRIKES);
  const last = run[0]?.closed?.at ?? 0;
  const first = run.at(-1)?.closed?.at ?? 0;
  if (run.length === STRIKES && run.every(strike) && last - first <= STRIKE_WINDOW_MS && now < last + STRIKE_LOCK_MS) {
    return {
      reason: "strikes",
      text: `Not changed: your last ${STRIKES} asked changes were ${caller.door === "own" ? "declined or unanswered" : "declined"}, so t3flare refuses your asked changes until ${new Date(last + STRIKE_LOCK_MS).toISOString()} (${durationText(STRIKE_LOCK_MS)} after the last). Ask the owner in the thread what he wants.`,
    };
  }
  if (changes.appliedSince(caller.key, now - APPLIED_WINDOW_MS) >= APPLIED_CAP) {
    return { reason: "applied-cap", text: `Not changed: ${caller.door === "own" ? "this thread" : "you"} made ${APPLIED_CAP} settings changes in the last hour, the most t3flare allows. Try again later, or ask the owner.` };
  }
  return undefined;
};

// ── Waiters ──────────────────────────────────────────────────────────────────────────────────────────────────────

const waiters = new Map<string, Set<(outcome: ChangeOutcome) => void>>();

/** A promise of `id`'s outcome when it closes in this isolate; `cancel` stops waiting. */
export const waitForChange = (id: string): { readonly closed: Promise<ChangeOutcome>; readonly cancel: () => void } => {
  let resolve!: (outcome: ChangeOutcome) => void;
  const closed = new Promise<ChangeOutcome>((settle) => (resolve = settle));
  const set = waiters.get(id) ?? new Set();
  set.add(resolve);
  waiters.set(id, set);
  return {
    closed,
    cancel: () => {
      set.delete(resolve);
      if (set.size === 0) waiters.delete(id);
    },
  };
};

const settle = (id: string, outcome: ChangeOutcome) => {
  const set = waiters.get(id);
  waiters.delete(id);
  for (const resolve of set ?? []) resolve(outcome);
};

export const outcomeOf = (record: ChangeRecord): ChangeOutcome => ({
  state: record.state,
  ...(record.closed?.revision === undefined ? {} : { revision: record.closed.revision }),
  ...(record.closed?.error === undefined ? {} : { error: record.closed.error }),
  ...(record.closed?.by === undefined ? {} : { by: record.closed.by }),
});

// ── Answers ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Who answers: the card (the owner, by construction), or the identity a door admitted. */
export type Answerer = { readonly kind: "card" } | { readonly kind: "owner"; readonly subject: string } | { readonly kind: "service-token" };

export interface AnswerInput {
  readonly by: AnsweredBy;
  readonly answerer: Answerer;
  readonly action: "approve" | "decline";
  /** A header value typed on the Change page (plan D10): straight to the secret store, never kept or logged. */
  readonly secret?: string;
}

/** What applying an Open change answered. `authorizationUrl` is a sign-in's, for the page's own response only. */
export type ApplyResult = { readonly ok: true; readonly revision: number; readonly authorizationUrl?: string } | { readonly ok: false; readonly error: string; readonly moved?: number };

export interface AnswerDeps {
  readonly changes: SettingsChanges;
  readonly now: () => number;
  /** The entity's current revision. */
  readonly revisionOf: (entity: ChangeRecord["entity"]) => number;
  /** Applies the change through the ops with its expected revision. */
  readonly apply: (record: ChangeRecord, input: { readonly by: AnsweredBy; readonly secret?: string }) => Promise<ApplyResult>;
  readonly log?: (event: Record<string, unknown>) => void;
}

export type AnswerResult =
  | { readonly ok: true; readonly outcome: ChangeOutcome; readonly authorizationUrl?: string }
  /** Refused: nothing changed. `closed` is the change's outcome when it was already closed. */
  | { readonly ok: false; readonly status: 400 | 403 | 404 | 409; readonly error: string; readonly closed?: ChangeOutcome };

/** Why `answer` may not answer `record` (plan D8's table), or undefined. */
const answererProblem = (record: ChangeRecord, answer: AnswerInput): string | undefined => {
  const same = (): boolean =>
    record.caller.principal === "service-token" ? answer.answerer.kind === "service-token" : answer.answerer.kind === "owner" && answer.answerer.subject === record.caller.key;
  switch (answer.by) {
    case "card":
      if (record.mode !== "card" || answer.answerer.kind !== "card") return "this change is not answered on a card";
      break;
    case "page":
      if (record.caller.door === "own" ? answer.answerer.kind !== "owner" : !same()) return "only the owner who asked answers this change";
      break;
    case "client":
      if (record.mode !== "native" || !same()) return "this change is not answered by this client";
      break;
    case "agent":
      if (record.mode !== "model" || !same()) return "this change is not answered by this client's agent";
      break;
  }
  // A change that needs the page is approved there alone (plan D6); anyone who may answer it may decline it.
  if (answer.action === "approve" && record.needsPage !== undefined && answer.by !== "page") return "this change is approved on the Change page only";
  if (answer.action === "approve" && record.needsPage === "secret" && (answer.secret === undefined || answer.secret === "")) return "this change needs the header value, typed on the Change page";
  return undefined;
};

const closeAs = (deps: AnswerDeps, record: ChangeRecord, from: ReadonlyArray<ChangeState>, state: ChangeState, closed: NonNullable<ChangeRecord["closed"]>): ChangeOutcome | undefined => {
  const next: ChangeRecord = { ...record, state, closed };
  if (!deps.changes.replace(record.id, from, next)) return undefined;
  const outcome = outcomeOf(next);
  deps.log?.(closedLine(next));
  settle(record.id, outcome);
  return outcome;
};

/**
 * Answers Open change `id` (plan D8): one answer applies or declines it, and every later one finds it closed. Expiry,
 * the answerer and the revision are checked, and the state moved to `applying`, in one synchronous block before the
 * apply awaits anything.
 */
export const answerOpenChange = async (deps: AnswerDeps, id: string, answer: AnswerInput): Promise<AnswerResult> => {
  const record = deps.changes.get(id);
  if (record === undefined || record.tier !== "asked") return { ok: false, status: 404, error: `no such change (it may have closed over ${durationText(CLOSED_KEPT_MS)} ago)` };
  if (!isOpen(record)) return { ok: false, status: 409, error: `this change is already ${record.state}`, closed: outcomeOf(record) };
  if (record.state === "applying") return { ok: false, status: 409, error: "this change is being applied" };
  const problem = answererProblem(record, answer);
  if (problem !== undefined) return { ok: false, status: problem.startsWith("this change needs") ? 400 : 403, error: problem };
  const now = deps.now();
  if (answer.action === "decline") {
    const outcome = closeAs(deps, record, ["open"], "declined", { at: now, by: answer.by });
    return outcome === undefined ? { ok: false, status: 409, error: "this change was answered first elsewhere" } : { ok: true, outcome };
  }
  const current = deps.revisionOf(record.entity);
  if (current !== record.expectedRevision) {
    const outcome = closeAs(deps, record, ["open"], "moved", { at: now, by: answer.by, revision: current, error: `the settings moved to revision ${current} since it was asked` });
    return outcome === undefined ? { ok: false, status: 409, error: "this change was answered first elsewhere" } : { ok: true, outcome };
  }
  const applying: ChangeRecord = { ...record, state: "applying" };
  if (!deps.changes.replace(id, ["open"], applying)) return { ok: false, status: 409, error: "this change was answered first elsewhere" };
  let applied: ApplyResult;
  try {
    applied = await deps.apply(applying, { by: answer.by, ...(answer.secret === undefined ? {} : { secret: answer.secret }) });
  } catch (error) {
    applied = { ok: false, error: String(error).slice(0, 300) };
  }
  const at = deps.now();
  const outcome = applied.ok
    ? closeAs(deps, applying, ["applying"], "applied", { at, by: answer.by, revision: applied.revision })
    : applied.moved !== undefined
      ? closeAs(deps, applying, ["applying"], "moved", { at, by: answer.by, revision: applied.moved, error: applied.error })
      : closeAs(deps, applying, ["applying"], "failed", { at, by: answer.by, error: applied.error });
  const closed = outcome ?? outcomeOf(deps.changes.get(id) ?? applying);
  return { ok: true, outcome: closed, ...(applied.ok && applied.authorizationUrl !== undefined ? { authorizationUrl: applied.authorizationUrl } : {}) };
};

/**
 * Closes Open change `id` without an answer: `withdrawn` (the caller stopped, the card was cancelled, a stream was cut)
 * or `expired`. Answers its outcome, which is the earlier one when it had already closed.
 */
export const closeOpenChange = (deps: Pick<AnswerDeps, "changes" | "now" | "log">, id: string, state: "withdrawn" | "expired", by?: ClosedBy): ChangeOutcome | undefined => {
  const record = deps.changes.get(id);
  if (record === undefined) return undefined;
  if (record.state !== "open") return outcomeOf(record);
  const at = state === "expired" ? Math.min(deps.now(), record.expiresAt ?? deps.now()) : deps.now();
  return (
    closeAs({ ...deps, revisionOf: () => 0, apply: async () => ({ ok: false, error: "" }) }, record, ["open"], state, { at, ...(by === undefined ? {} : { by }) }) ??
    outcomeOf(deps.changes.get(id) ?? record)
  );
};

/** An Open change as a caller's `get_status` lists it and the panel's Open changes list shows it: never a secret. */
export const openChangeSummary = (record: ChangeRecord, url: string | undefined) => ({
  changeId: record.id,
  tool: record.tool,
  subject: record.shown?.subject ?? record.entity,
  reasons: record.shown?.reasons ?? [],
  state: record.state,
  mode: record.mode ?? null,
  ...(record.needsPage === undefined ? {} : { needsPage: record.needsPage }),
  door: record.caller.door,
  principal: record.caller.principal,
  ...(record.caller.thread === undefined ? {} : { thread: record.caller.thread }),
  ...(record.caller.agent === undefined ? {} : { agent: record.caller.agent }),
  ...(record.caller.client === undefined ? {} : { client: record.caller.client }),
  createdAt: new Date(record.createdAt).toISOString(),
  expiresAt: new Date(record.expiresAt ?? record.createdAt).toISOString(),
  ...(url === undefined ? {} : { url }),
});

export type OpenChangeSummary = ReturnType<typeof openChangeSummary>;

/** What the Change page and the panel's list run over (plan D10): the table, and answers by the page. */
export interface ChangesApi {
  readonly list: () => ReadonlyArray<ChangeRecord>;
  readonly get: (id: string) => ChangeRecord | undefined;
  /** The page's answer, by the identity the panel admitted. */
  readonly answer: (id: string, input: Omit<AnswerInput, "by">) => Promise<AnswerResult>;
}
