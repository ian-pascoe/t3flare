// Review C2 (step 3): a delegated task's question across an Environment restart. t3's startup recovery keeps a pending
// question (a `user_input` request) answerable by a message, but cancels its run, and a run a restart cut while it
// waited on the owner gets no continuation (ADR-0004's step 2a refinement). A laptop following a remote task would then
// complete the task from the cancelled run's last reply. So, once t3 takes commands after a boot, each thread delegated
// from another environment (`delegatedFrom`) whose run was cancelled while its question waited gets that question
// raised again: a continuation of the cancelled run (`restartContinuationOfRunId`, which the laptop's wait follows) whose
// prompt carries the question as t3 stored it, and the stale request dismissed. The agent asks it again with `ask_user`.
import type { CommandId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import * as ThreadManagementService from "t3/src/orchestration-v2/ThreadManagementService.ts";

import { environmentServices } from "./bindings.ts";

type Candidate = { thread_id: string; runtime_request_id: string; node_id: string };

/** The prompt that raises `question` again. */
export const reraisePrompt = (question: { readonly question: string; readonly options: ReadonlyArray<string> }): string =>
  [
    "T3 Code restarted while you were waiting for the owner's answer to your question, so the question was lost.",
    `Ask it again now with the ask_user tool, exactly: "${question.question}"${question.options.length === 0 ? "" : ` with the options ${JSON.stringify(question.options)}`}.`,
    "Then continue your task from the answer. Before you repeat any other action that changes state, check whether it already took effect.",
  ].join(" ");

export const reraiseQuestionsAfterRestart = Effect.gen(function* () {
  const candidates = environmentServices()
    .sql.exec<Candidate>(
      `SELECT r.thread_id, r.runtime_request_id, r.node_id
       FROM orchestration_v2_projection_runtime_requests r
       JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
       WHERE r.status = 'pending' AND r.kind = 'user_input'
         AND json_extract(r.payload_json, '$.responseCapability.type') = 'message'
         AND json_extract(t.payload_json, '$.delegatedFrom') IS NOT NULL
         AND t.deleted_at IS NULL`,
    )
    .toArray();
  if (candidates.length === 0) return 0;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  let raised = 0;
  for (const candidate of candidates) {
    const threadId = candidate.thread_id as ThreadId;
    const records = yield* threads.getThreadRecords(threadId, ["runs", "nodes", "turnItems"], { turnItemTypes: ["user_input_request"] });
    const runId = records.nodes.find((node) => node.id === candidate.node_id)?.runId ?? null;
    const run = records.runs.find((candidateRun) => candidateRun.id === runId);
    // Only a run the restart cancelled, with nothing after it: a later run (an answer, a continuation) owns the thread.
    if (run === undefined || run.status !== "cancelled" || records.runs.some((other) => other.id !== run.id && runRanAfter(other, run))) continue;
    const item = records.turnItems.find((turnItem) => turnItem.type === "user_input_request" && turnItem.requestId === candidate.runtime_request_id);
    const question = item?.type === "user_input_request" ? item.questions[0] : undefined;
    if (question === undefined) continue;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: `command:t3flare-question-reraise:${candidate.runtime_request_id}` as CommandId,
      threadId,
      messageId: `message:t3flare-question-reraise:${candidate.runtime_request_id}` as MessageId,
      text: reraisePrompt({ question: question.question, options: question.options.map((option) => option.value ?? option.label) }),
      attachments: [],
      modelSelection: run.modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: run.id as RunId,
    } as never);
    yield* threads.dispatch({
      type: "thread.user-input.dismiss",
      commandId: `command:t3flare-question-dismiss:${candidate.runtime_request_id}` as CommandId,
      threadId,
      requestId: candidate.runtime_request_id,
    } as never);
    raised++;
    yield* Effect.logInfo("t3flare: a delegated task's question raised again after a restart", { threadId, runId: run.id });
  }
  return raised;
}).pipe(Effect.catchCause((cause) => Effect.logWarning("t3flare: delegated questions were not raised again", cause).pipe(Effect.as(0))));
