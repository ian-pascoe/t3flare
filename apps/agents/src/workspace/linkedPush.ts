// The push gateway's policy (SPI-992; owner decision D1, step 3; review H1, M2). No token that can write enters a
// Container: every push reaches GitHub through the gateway (`pushGateway.ts`), which asks this policy about the
// request's exact ref updates.
//
// - Linked work: a Session whose thread carries a link origin notes, before each of its commands, that linked work is
//   active in the Workspace (until LINKED_WORK_MS after that command started); a linked thread's CLI process counts
//   while it lives.
// - Taint (review H1): the first linked work taints the Workspace, durably: past the window, across Container stops,
//   into the worktrees made from it. A planted hook, `core.fsmonitor` or script runs later as the owner, so while the
//   Workspace is tainted every push asks, until the owner trusts it again.
// - t3's own push (the owner's "Commit & push", OD-5): the process router registers what it is about to push (an
//   expectation, `{ref, new}` per update); a request whose updates are all one expectation's is t3's and goes ahead.
//   Expectations are not secrets: a process that races one can push only what the owner clicked.

/** How long after a linked thread's command started its Workspace counts as holding linked work. */
export const LINKED_WORK_MS = 30 * 60_000;
/** How long a push waits for the owner's answer (the gateway's request is held that long). */
export const PUSH_APPROVAL_MS = 10 * 60_000;
/** The longest an expectation lives: it is removed when the router's git command returns, this is the backstop. */
export const EXPECTATION_MAX_MS = 30 * 60_000;
/** How long after an owner Session's command started it counts as possibly pushing (attribution, H1). */
export const OWNER_COMMAND_MS = 15 * 60_000;

/** The linked Sessions that ran commands in a Workspace (and live linked CLI threads, `cli:<thread>`): until when each counts. */
export type LinkedWork = Readonly<Record<string, number>>;

/** A Workspace's durable taint: since when, and which linked threads added to it. */
export interface Taint {
  readonly since: number;
  readonly by: ReadonlyArray<string>;
}

/** What t3's own push is about to update (the router's expectation). */
export interface PushExpectation {
  readonly id: string;
  readonly updates: ReadonlyArray<{ readonly ref: string; readonly new: string }>;
  readonly until: number;
}

/** Who is asked: a Session (by name) or a CLI thread (asked through the Environment), linked or the owner's. */
export type Asked = { readonly kind: "session"; readonly name: string; readonly linked: boolean } | { readonly kind: "cli"; readonly thread: string; readonly linked: boolean };

export type PushDecision =
  | { readonly kind: "allow"; readonly why: "untainted" }
  | { readonly kind: "allow"; readonly why: "expected"; readonly expectation: string }
  | { readonly kind: "ask"; readonly on: Asked }
  | { readonly kind: "refuse"; readonly reason: string };

export interface PushContext {
  readonly updates: ReadonlyArray<{ readonly ref: string; readonly new: string }>;
  readonly linked: LinkedWork;
  readonly taint: Taint | null;
  readonly expectations: ReadonlyArray<PushExpectation>;
  /** The owner's threads that could be the one pushing: Sessions with a recent command, CLI threads in a turn. */
  readonly owners: { readonly sessions: ReadonlyArray<string>; readonly cli: ReadonlyArray<string> };
  readonly now: number;
}

/** The id of the live expectation every one of `updates` belongs to, if one does. */
export const matchExpectation = (expectations: ReadonlyArray<PushExpectation>, updates: PushContext["updates"], now: number): string | undefined =>
  expectations.find((expectation) => expectation.until > now && updates.length > 0 && updates.every((u) => expectation.updates.some((e) => e.ref === u.ref && e.new === u.new)))?.id;

/** Refused while tainted with no one to ask (H1). */
export const TAINTED_NO_ONE_TO_ASK =
  "this Workspace ran linked work, so each push needs your approval, and none of your threads could be asked; push with Commit & push, or trust the Workspace again";

/** What a push gets: allowed (t3's own, or an untainted Workspace), asked of one thread, or refused. */
export const pushDecision = (context: PushContext): PushDecision => {
  const expectation = matchExpectation(context.expectations, context.updates, context.now);
  if (expectation !== undefined) return { kind: "allow", why: "expected", expectation };
  const active = Object.entries(context.linked)
    .filter(([, until]) => until > context.now)
    .sort(([, a], [, b]) => b - a);
  const latest = active[0]?.[0];
  if (latest !== undefined) return { kind: "ask", on: latest.startsWith("cli:") ? { kind: "cli", thread: latest.slice(4), linked: true } : { kind: "session", name: latest, linked: true } };
  if (context.taint === null) return { kind: "allow", why: "untainted" };
  const { sessions, cli } = context.owners;
  if (sessions.length + cli.length === 1) return { kind: "ask", on: sessions.length === 1 ? { kind: "session", name: sessions[0]!, linked: false } : { kind: "cli", thread: cli[0]!, linked: false } };
  return { kind: "refuse", reason: TAINTED_NO_ONE_TO_ASK };
};

/** The taint after linked thread `by` ran work (or a live linked CLI process) at `now`. */
export const taintAfter = (taint: Taint | null, by: string, now: number): Taint =>
  taint === null ? { since: now, by: [by] } : taint.by.includes(by) ? taint : { since: taint.since, by: [...taint.by, by].slice(-20) };

/** Forgets linked work that no longer counts. */
export const prunedLinkedWork = (linked: LinkedWork, now: number): LinkedWork =>
  Object.fromEntries(Object.entries(linked).filter(([, until]) => until > now));
