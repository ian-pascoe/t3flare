// Owner decision D1 (step 3, option 2; review C3): work started over a Peer link may `git push` the project's repo, but
// every push needs its own approval. A remote task runs in the project's shared checkout, and the Container token is
// per Workspace, so the gate is where the token is handed out: the git credential helper's request to the Workspace DO.
//
// - A Session whose thread carries a link origin notes, before each of its commands, that linked work is active in the
//   Workspace (until LINKED_WORK_MS after that command started).
// - While any is active, the helper's request says what git is doing (`op`, read by the helper from its git ancestors).
//   A fetch gets a read-only token, so claiming "fetch" for a push only makes the push fail; anything else asks the
//   linked Session's owner for this push alone (never accepted for the session), and gets the write token only when
//   approved. No live linked turn to ask, or no answer in time: no token.
// - With no linked work active the helper's token is the Workspace's, as before (ADR-0013).

/** How long after a linked thread's command started its Workspace counts as holding linked work. */
export const LINKED_WORK_MS = 30 * 60_000;
/** How long a push waits for the owner's answer (the helper's request is held that long). */
export const PUSH_APPROVAL_MS = 10 * 60_000;

/** The linked Sessions that ran commands in a Workspace: until when each counts, by Session name. */
export type LinkedWork = Readonly<Record<string, number>>;

export type CredentialDecision =
  | { readonly kind: "token" }
  | { readonly kind: "read-only" }
  | { readonly kind: "ask"; readonly session: string };

/** What the helper's request gets: the Workspace's token, a read-only one, or the approval of the latest linked Session. */
export const credentialDecision = (linked: LinkedWork, now: number, op: string | null): CredentialDecision => {
  const active = Object.entries(linked)
    .filter(([, until]) => until > now)
    .sort(([, a], [, b]) => b - a);
  if (active.length === 0) return { kind: "token" };
  if (op === "fetch") return { kind: "read-only" };
  return { kind: "ask", session: active[0]![0] };
};

/** Forgets linked work that no longer counts. */
export const prunedLinkedWork = (linked: LinkedWork, now: number): LinkedWork =>
  Object.fromEntries(Object.entries(linked).filter(([, until]) => until > now));
