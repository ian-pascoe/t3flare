// SPI-1040: a push from a CLI thread's Workspace, asked of the owner on that thread (the push gateway's policy, through
// the Environment DO's `approvePush`). The CLI wrapper (`wrapper.ts`) registers an asker for each thread while its turn
// runs; the asker raises t3's approval card on that turn and answers when the owner does. A thread with no live turn
// is refused, as before SPI-992 for linked CLI work (step 4a F8).

/** What the gateway asks: the card's text (`pushCard`), whether the work came through a link, and the ask's id. */
export interface CliPushAsk {
  readonly askId: string;
  readonly linked: boolean;
  readonly summary: string;
  readonly detail: string;
}

export interface CliPushAnswer {
  readonly approved: boolean;
  readonly trust?: boolean;
  readonly reason?: string;
}

/** A live turn's way to ask: resolves with the owner's answer, or a refusal when the turn ends or the ask is withdrawn. */
export interface CliPushAsker {
  readonly linked: boolean;
  readonly ask: (ask: CliPushAsk, signal: AbortSignal) => Promise<CliPushAnswer>;
}

/** As long as the Session's push card waits (agents' PUSH_APPROVAL_MS): the gateway holds the git request meanwhile. */
export const CLI_PUSH_APPROVAL_MS = 10 * 60_000;

const askers = new Map<string, CliPushAsker>();
const withdrawals = new Map<string, AbortController>();

/** Registers the live turn of `thread`; the returned function unregisters it (only if still the registered one). */
export const registerCliPushAsker = (thread: string, asker: CliPushAsker): (() => void) => {
  askers.set(thread, asker);
  return () => {
    if (askers.get(thread) === asker) askers.delete(thread);
  };
};

export const approveCliPush = async (input: { readonly thread: string; readonly linked: boolean } & CliPushAsk): Promise<CliPushAnswer> => {
  const asker = askers.get(input.thread);
  if (asker === undefined) return { approved: false, reason: `no live turn to ask on (thread ${input.thread})` };
  // As the Session's `approveGitPush`: the Workspace's view of the link must be the thread's own.
  if (input.linked && !asker.linked) return { approved: false, reason: "not linked work" };
  if (!input.linked && asker.linked) return { approved: false, reason: "a linked thread cannot trust the Workspace" };
  const withdrawn = new AbortController();
  withdrawals.set(input.askId, withdrawn);
  try {
    const answer = await asker.ask(
      { askId: input.askId, linked: input.linked, summary: input.summary, detail: input.detail },
      AbortSignal.any([AbortSignal.timeout(CLI_PUSH_APPROVAL_MS), withdrawn.signal]),
    );
    if (answer.reason === "withdrawn") return { approved: false, reason: withdrawn.signal.aborted ? "git went away" : "no answer in time" };
    // A linked thread never trusts the Workspace again (D1): each of its pushes asks.
    return input.linked && answer.trust === true ? { ...answer, trust: false } : answer;
  } finally {
    withdrawals.delete(input.askId);
  }
};

/** Withdraws the card of a push whose git went away (review M7). */
export const cancelCliPush = (askId: string): void => withdrawals.get(askId)?.abort();
