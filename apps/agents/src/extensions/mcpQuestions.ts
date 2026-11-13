// An MCP server's questions on a Durable thread (SPI-1079, ADR-0028's elicitation refinement). The Environment's MCP host
// makes a card of each question a server asks during the Session's call, and calls the `asker` the Session passed with
// the call (Workers RPC carries it); the Session shows the card as a pending approval (`mcp-elicitation`) or a question
// (a form), pushed as every request is, and hands back the owner's answer.
//
// Held in memory only: the call that waits is a live RPC, so a restart ends it anyway (the card then closes as
// cancelled), and the answer never touches the Session's storage (cloudpid ADR-0041: never kept). Stop, the turn's end,
// the server's own withdrawal and the host's timeout close the card.
// @effect-diagnostics globalDate:off
import type { AnswerInput, McpAsker, McpQuestionAnswer, McpQuestionCard, PendingApproval, PendingQuestion } from "@t3flare/session-protocol";

interface Waiting {
  readonly approval?: PendingApproval;
  readonly question?: PendingQuestion;
  readonly resolve: (answer: McpQuestionAnswer) => void;
}

export class McpQuestions {
  readonly #pending = new Map<string, Waiting>();
  readonly #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  approvals(): ReadonlyArray<PendingApproval> {
    return [...this.#pending.values()].flatMap((waiting) => (waiting.approval === undefined ? [] : [waiting.approval]));
  }

  questions(): ReadonlyArray<PendingQuestion> {
    return [...this.#pending.values()].flatMap((waiting) => (waiting.question === undefined ? [] : [waiting.question]));
  }

  has(requestId: string): boolean {
    return this.#pending.has(requestId);
  }

  #settle(requestId: string, answer: McpQuestionAnswer): boolean {
    const waiting = this.#pending.get(requestId);
    if (waiting === undefined) return false;
    this.#pending.delete(requestId);
    waiting.resolve(answer);
    this.#changed();
    return true;
  }

  /** The owner's answer from t3: an approval card's decision, or a form card's answers. */
  answer(input: AnswerInput): boolean {
    const waiting = this.#pending.get(input.requestId);
    if (waiting === undefined) return false;
    if (waiting.question !== undefined && input.answers !== undefined) return this.#settle(input.requestId, { decision: "accept", answers: input.answers });
    return this.#settle(input.requestId, { decision: input.decision === "accept" && waiting.question !== undefined ? "cancel" : input.decision });
  }

  /** Closes the cards of turns no longer live. */
  dropAbandoned(liveTurns: ReadonlySet<string>): void {
    for (const [requestId, waiting] of this.#pending) {
      const turn = waiting.approval?.turn ?? waiting.question?.turn ?? null;
      if (turn === null || !liveTurns.has(turn)) this.#settle(requestId, { decision: "cancel", reason: "the turn ended" });
    }
  }

  /** The asker for one call of turn `turn`: its cards close when `signal` aborts (Stop). */
  asker(turn: string | null, callId: string, signal: AbortSignal | undefined): McpAsker {
    return {
      ask: (card: McpQuestionCard) =>
        new Promise<McpQuestionAnswer>((resolve) => {
          if (turn === null) return resolve({ decision: "cancel", reason: "no live turn to ask on" });
          if (signal?.aborted === true) return resolve({ decision: "cancel", reason: "withdrawn" });
          const base = { requestId: card.id, turn, callId, createdAt: Date.now() };
          const onAbort = () => this.#settle(card.id, { decision: "cancel", reason: "withdrawn" });
          signal?.addEventListener("abort", onAbort, { once: true });
          const done = (answer: McpQuestionAnswer) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(answer);
          };
          this.#pending.set(
            card.id,
            card.kind === "form" && card.questions !== undefined
              ? { question: { ...base, question: card.title, options: [], allowFreeText: false, questions: card.questions }, resolve: done }
              : {
                  approval: { ...base, tool: card.server, kind: "mcp-elicitation", title: card.title, summary: card.prompt, ...(card.options === undefined ? {} : { options: card.options }) },
                  resolve: done,
                },
          );
          this.#changed();
        }),
      withdraw: (cardId: string) => {
        this.#settle(cardId, { decision: "cancel", reason: "withdrawn" });
      },
    };
  }
}
