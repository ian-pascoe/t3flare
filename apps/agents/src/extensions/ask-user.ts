// The `ask_user` tool (step 3, plan section 3.2): the Durable agent asks the owner one question, with optional choices,
// and waits durably for the answer, as an approval waits (`permissions.ts`): kept in the Session's storage, asked again
// by a rerun after a restart, each wait marked as progress. The Session pushes it as a question; the differ opens a
// t3 `user_input` request; the owner answers in a client, or an agent with `t3_pending_request`. A Stop withdraws it.
// @effect-diagnostics asyncFunction:off globalConsole:off globalDate:off
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { arr, bool, obj, opt, str } from "@earendil-works/pi-schema";
import type { PendingQuestion } from "@t3flare/session-protocol";

import { type ApprovalStorage, WaitingRequests } from "./permissions.ts";

const QUESTIONS_KEY = "t3flare:questions";
const QUESTION_ANSWERS_KEY = "t3flare:question-answers";
/** Most characters of a question, and of each choice. */
const MAX_QUESTION = 2_000;
const MAX_OPTION = 200;
const MAX_OPTIONS = 10;

/** The Session's questions to the owner. */
export class QuestionStore extends WaitingRequests<PendingQuestion, { readonly text: string }> {
  constructor(storage: ApprovalStorage, changed: () => void) {
    super(storage, { requests: QUESTIONS_KEY, answers: QUESTION_ANSWERS_KEY }, changed);
  }

  /** The owner's answer; false when no such question waits. */
  answer(requestId: string, text: string): boolean {
    return this.give(requestId, { text }) !== undefined;
  }
}

/** An answer as t3 hands it to a provider (a string, a list of choices, or `{ answers }`), as text. */
export const answerText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => answerText(item) ?? "").filter((item) => item !== "").join(", ");
  if (typeof value === "object" && value !== null && "answers" in value) return answerText((value as { answers: unknown }).answers);
  return undefined;
};

export interface AskUserHost {
  readonly store: QuestionStore;
  readonly turn: () => string | null;
}

export const askUser = (host: AskUserHost): Extension =>
  defineExtension({
    name: "ask-user",
    tools: [
      defineTool({
        name: "ask_user",
        description:
          "Ask the owner one question and wait for the answer. Use it only when a decision you cannot make yourself would change the result; give `options` when the answer is a choice. The owner may answer much later.",
        parameters: obj({
          question: str({ description: "The question, complete on its own." }),
          options: opt(arr(str(), { description: "Choices the owner picks from (at most 10)." })),
          allowFreeText: opt(bool({ description: "Whether the owner may answer in their own words. Default true." })),
        }),
        // The wait is replay-safe: a rerun waits again for the same question, or takes the answer given meanwhile.
        replay: "safe",
        async execute(args, api: ToolExecutionApi, context: Context) {
          const requestId = String(api.taskId);
          const options = (args.options ?? []).slice(0, MAX_OPTIONS).map((option) => option.slice(0, MAX_OPTION)).filter((option) => option.trim() !== "");
          try {
            const answer = await host.store.ask(
              {
                requestId,
                turn: host.turn(),
                callId: api.callId,
                question: args.question.slice(0, MAX_QUESTION),
                options,
                allowFreeText: args.allowFreeText ?? true,
                createdAt: Date.now(),
              },
              () => api.progressed(context).catch((error: unknown) => console.warn(JSON.stringify({ t3flare: "progressed-failed", error: String(error) }))),
              context,
            );
            return { output: [{ type: "text" as const, text: `The owner answered: ${answer.text}` }] };
          } finally {
            host.store.settle(requestId);
          }
        },
      }),
    ],
  });
