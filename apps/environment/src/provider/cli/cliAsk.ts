// The MCP relay's tool cards on a CLI thread (ADR-0028, review M9). The CLI wrapper (`wrapper.ts`) registers an asker
// for each thread while its session lives; the asker raises t3's approval card on the thread's live turn and answers
// when the owner does. A thread with no live turn is refused. (Before the back-to-stock cut, owner 2026-11-12, the
// push gateway's cards came this way too; pushes no longer ask.)

/** What the relay asks: the card's text, its buttons, its title and t3's request kind, and the ask's id. */
export interface CliAsk {
  readonly askId: string;
  readonly summary: string;
  readonly detail: string;
  readonly options: ReadonlyArray<{ readonly decision: "accept" | "acceptForSession" | "decline"; readonly label: string; readonly warning?: string }>;
  readonly title: string;
  readonly requestKind: "command" | "permission";
}

export interface CliAnswer {
  readonly approved: boolean;
  /** The owner chose the card's "for the session" answer. */
  readonly forSession?: boolean;
  readonly reason?: string;
}

/** A live turn's way to ask: resolves with the owner's answer, or a refusal when the turn ends or the ask is withdrawn. */
export interface CliAsker {
  /** The thread's modes as its session last set them, and its Workspace (the relay's decision, review M7). */
  readonly state?: () => { readonly runtimeMode: string | undefined; readonly interactionMode: string | undefined; readonly workspace: string | null };
  readonly ask: (ask: CliAsk, signal: AbortSignal) => Promise<CliAnswer>;
}

/** How long a card waits for the owner. */
export const CLI_ASK_MS = 10 * 60_000;

const askers = new Map<string, CliAsker>();
const withdrawals = new Map<string, AbortController>();

/** Registers the live session of `thread`; the returned function unregisters it (only if still the registered one). */
export const registerCliAsker = (thread: string, asker: CliAsker): (() => void) => {
  askers.set(thread, asker);
  return () => {
    if (askers.get(thread) === asker) askers.delete(thread);
  };
};

/** Withdraws the card of a call whose CLI went away. */
export const cancelCliAsk = (askId: string): void => withdrawals.get(askId)?.abort();

/** A CLI thread's modes, for the relay: the call follows its own thread's (undefined when it has no live session). */
export const cliThreadState = (thread: string): { readonly runtimeMode: string | undefined; readonly interactionMode: string | undefined } | undefined => askers.get(thread)?.state?.();

/**
 * The relay's question about one tool call (ADR-0028), on the calling thread's live turn, linked threads included
 * (owner, 2026-11-12, back to stock: no per-call rule).
 */
export const approveCliTool = async (input: { readonly thread: string; readonly askId: string; readonly title: string; readonly summary: string; readonly detail: string }): Promise<CliAnswer> => {
  const asker = askers.get(input.thread);
  if (asker === undefined) return { approved: false, reason: `no live turn to ask on (thread ${input.thread})` };
  const options: CliAsk["options"] = [
    { decision: "accept", label: "Allow" },
    { decision: "acceptForSession", label: "Allow this tool for the rest of the session" },
    { decision: "decline", label: "Decline" },
  ];
  const withdrawn = new AbortController();
  withdrawals.set(input.askId, withdrawn);
  try {
    const answer = await asker.ask(
      { askId: input.askId, summary: input.summary, detail: input.detail, options, title: input.title, requestKind: "permission" },
      AbortSignal.any([AbortSignal.timeout(CLI_ASK_MS), withdrawn.signal]),
    );
    if (answer.reason === "withdrawn") return { approved: false, reason: withdrawn.signal.aborted ? "the agent went away" : "no answer in time" };
    if (!answer.approved) return { approved: false, reason: answer.reason ?? "declined" };
    return { approved: true, forSession: answer.forSession === true };
  } finally {
    withdrawals.delete(input.askId);
  }
};
