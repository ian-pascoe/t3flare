// SPI-1040: a push from a CLI thread's Workspace, asked of the owner on that thread (the push gateway's policy, through
// the Environment DO's `approvePush`). The CLI wrapper (`wrapper.ts`) registers an asker for each thread while its turn
// runs; the asker raises t3's approval card on that turn and answers when the owner does. A thread with no live turn
// is refused, as before SPI-992 for linked CLI work (step 4a F8).
//
// ADR-0028 (review M9): the same askers raise the MCP relay's tool cards (`approveCliTool`). A tool card has its own
// `perCall` flag (a linked or tainted caller's write: this call only) and never offers the push card's "trust this
// Workspace again"; its ids keep the `t3flare-push` prefix, so a stale one after a restart is closed the same way.

/** What the gateway asks: the card's text (`pushCard`), whether the work came through a link, and the ask's id. */
export interface CliPushAsk {
  readonly askId: string;
  readonly linked: boolean;
  readonly summary: string;
  readonly detail: string;
  /** The card's buttons (`pushCardOptions`): only an owner's card offers the trust answer, labelled as such. */
  readonly options: ReadonlyArray<{ readonly decision: "accept" | "acceptForSession" | "decline"; readonly label: string; readonly warning?: string }>;
  /** The card's title and t3's request kind: a push's by default ("Allow git push?", `command`). */
  readonly title?: string;
  readonly requestKind?: "command" | "permission";
}

export interface CliPushAnswer {
  readonly approved: boolean;
  readonly trust?: boolean;
  readonly reason?: string;
}

/** A live turn's way to ask: resolves with the owner's answer, or a refusal when the turn ends or the ask is withdrawn. */
export interface CliPushAsker {
  readonly linked: boolean;
  /** The thread's modes as its session last set them, and its Workspace (the relay's decision, review M7). */
  readonly state?: () => { readonly runtimeMode: string | undefined; readonly interactionMode: string | undefined; readonly workspace: string | null };
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
      { askId: input.askId, linked: input.linked, summary: input.summary, detail: input.detail, options: input.options },
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

/** The live threads' modes, for the relay's strictest-mode rule (review M7); a thread with no live turn is skipped. */
export const cliThreadStates = (threads: ReadonlyArray<string>): ReadonlyArray<{ readonly thread: string; readonly runtimeMode: string | undefined; readonly interactionMode: string | undefined; readonly workspace: string | null }> =>
  threads.flatMap((thread) => {
    const state = askers.get(thread)?.state?.();
    return state === undefined ? [] : [{ thread, ...state }];
  });

export interface CliToolAnswer {
  readonly approved: boolean;
  /** The owner accepted this tool for the rest of the thread's session (never for a per-call ask). */
  readonly forSession?: boolean;
  readonly reason?: string;
}

/**
 * The relay's question about one tool call (ADR-0028), on the calling thread's live turn. `perCall`: a linked or
 * tainted caller's write, whose card offers no "for the session" answer and whose approval covers this call only.
 */
export const approveCliTool = async (input: { readonly thread: string; readonly linked: boolean; readonly perCall: boolean; readonly askId: string; readonly title: string; readonly summary: string; readonly detail: string }): Promise<CliToolAnswer> => {
  const asker = askers.get(input.thread);
  if (asker === undefined) return { approved: false, reason: `no live turn to ask on (thread ${input.thread})` };
  if (input.linked && !asker.linked) return { approved: false, reason: "not linked work" };
  const perCall = input.perCall || input.linked || asker.linked;
  const options: CliPushAsk["options"] = perCall
    ? [
        { decision: "accept", label: "Allow this call" },
        { decision: "decline", label: "Decline" },
      ]
    : [
        { decision: "accept", label: "Allow" },
        { decision: "acceptForSession", label: "Allow this tool for the rest of the session" },
        { decision: "decline", label: "Decline" },
      ];
  const withdrawn = new AbortController();
  withdrawals.set(input.askId, withdrawn);
  try {
    const answer = await asker.ask(
      { askId: input.askId, linked: input.linked, summary: input.summary, detail: input.detail, options, title: input.title, requestKind: "permission" },
      AbortSignal.any([AbortSignal.timeout(CLI_PUSH_APPROVAL_MS), withdrawn.signal]),
    );
    if (answer.reason === "withdrawn") return { approved: false, reason: withdrawn.signal.aborted ? "the agent went away" : "no answer in time" };
    if (!answer.approved) return { approved: false, reason: answer.reason ?? "declined" };
    return { approved: true, forSession: !perCall && answer.trust === true };
  } finally {
    withdrawals.delete(input.askId);
  }
};
