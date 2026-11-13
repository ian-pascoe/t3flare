// Adapted from cloudpid@93ba45a3:packages/extensions/src/context/rollover.ts (SPI-1056), as plain pi-durable code: the
// agent writes its own Handoff instead of the generated summary of a compaction. `context_rollover` returns
// `control: { handoff }`, which pi-durable applies once the whole tool round is done: it appends a `pi.reset` entry
// carrying the Handoff and the same run goes on in the new context, where a steer the tool queued, placed right after the
// Handoff, tells the agent to continue. The `beforeCompact` hook turns a background threshold compaction into a Rollover
// request; a compaction that cannot wait for the agent (a blocking threshold one, or an overflow one) is the Emergency
// Rollover, whose summary is the last saved Handoff.
//
// How it sits with the other compactions (the reconciliation, SPI-1056):
// - pi-durable's own compaction stays the mechanism: thresholds, the cut that never splits a call from its result, the
//   overflow recovery. This hook only changes what fills the summary, and only where `context_rollover` is offered; with
//   the context extension off, or its `rolloverOnCompaction` setting off, pi-durable summarizes as before.
// - A manual compaction keeps pi-durable's summary. t3's idle compaction is locked off for every provider (K9,
//   `managedPolicy.ts`) and never reaches a Durable agent.
// - Changed from cloudpid's: no owner `/rollover` (t3 has no surface for it), so a Rollover never ends its run; the
//   requests the hook and the tool submit are steers that never start a run of their own (`whenIdle: "reject"`), so no
//   work happens outside a turn t3 started.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalConsole:off
import type { Context } from "@earendil-works/chord";
import {
  CompactionTask,
  type ConversationId,
  defineTool,
  type Harness,
  hook,
  type HookRegistration,
  LiveDoc,
  type ToolRegistration,
  type ToolTaskInput,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

import { ContextDoc, EMPTY_STATE, MAX_NOTE_CHARACTERS, type Note, noteIndex } from "./notes.ts";
import { readEntry } from "./tools.ts";

/** The Rollover request's entry: its own kind and a notice title, so the transcript shows it as a notice, not user input. */
export const PREPARE_ENTRY = { kind: "t3flare.context-prepare", data: { notice: "Rollover requested" } } as const;

/** The entry of the input that continues the task after a Handoff. */
export const CONTINUE_ENTRY = { kind: "t3flare.context-continue", data: { notice: "Continued after the Handoff" } } as const;

/** The request ID prefix of Rollover requests; the suffix names the Context Window it was made in. */
const PREPARE_REQUEST = "context-prepare:";

export const PREPARE_PROMPT =
  "Prepare a Context Rollover for the current task: the context is nearly full. Update useful Notes, then call context_rollover as the only tool call of its round with an explicit Handoff containing the objective, decisions, current state, and next actions. Continue the task after the checkpoint.";

export const CONTINUE_PROMPT = "The context rolled over. Continue the task from the Handoff above; read Notes and History when you need them.";

const HISTORY_HINT = "Earlier History, from before this Handoff, stays readable with context_history (windows, list, search, read).";

/** The first message of a new context: the agent's Handoff, then the Note Index. */
export const handoffText = (conversationId: ConversationId, handoff: string, notes: ReadonlyArray<Note>): string =>
  ["Context Window Handoff", `Agent-written Handoff:\n\n${handoff}`, noteIndex(conversationId, notes), HISTORY_HINT].join("\n\n");

/** The summary of an Emergency Rollover: the last saved Handoff, which may be stale, and the Note Index. */
export const emergencyText = (conversationId: ConversationId, handoff: string | null, notes: ReadonlyArray<Note>): string =>
  [
    "Context Window Handoff",
    "Emergency Rollover: the context filled up before a fresh Handoff, so the saved Handoff below may be stale or absent. Recover recent work from History before continuing.",
    handoff ?? "No saved Handoff. Recover the user's task from recent History and Notes.",
    noteIndex(conversationId, notes),
    HISTORY_HINT,
  ].join("\n\n");

const NOT_ALONE = "Rollover must be the sole tool call of its round; call context_rollover alone";

export const contextRolloverTool = (): ToolRegistration =>
  defineTool({
    name: "context_rollover",
    description:
      "Save an agent-written Handoff and start a fresh context from it after this tool round; Notes and History stay available. Must be the only tool call of its round.",
    parameters: obj({
      handoff: str({
        minLength: 1,
        maxLength: MAX_NOTE_CHARACTERS,
        description: "What the next context needs to continue: the objective, decisions, current state, and next actions",
      }),
    }),
    // Scripts cannot hand off: the Handoff ends the model's context.
    callers: ["model"],
    async execute(args, api, context) {
      if (args.handoff.trim() === "") throw new Error(`Supply a non-empty Handoff of at most ${MAX_NOTE_CHARACTERS} characters`);
      const task = await api.getTask(api.taskId, context);
      // SAFETY: a tool call's task is a `pi.tool` task, whose input is a `ToolTaskInput`.
      const input = task?.input as ToolTaskInput | undefined;
      if (input?.kind !== "model") throw new Error(NOT_ALONE);
      // The round's other calls would run before the new context starts, and their results would not be in it.
      const assistant = await readEntry(api, api.conversationId, input.assistant, context);
      const message = assistant?.model?.[0];
      const calls = message?.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : [];
      if (calls.length !== 1 || calls[0]?.id !== api.callId) throw new Error(NOT_ALONE);
      const notes = await api.commit(async (tx) => {
        const state = await tx.doc(ContextDoc, api.conversationId);
        state.handoff = args.handoff;
        return state.notes.map((note) => ({ ...note }));
      }, context);
      // pi-durable goes on with this run in the new context and places a steer queued now right after the Handoff, so the
      // next request asks the agent to continue. Never a run of its own: the run is live while this call is.
      const conversation = await api.conversation(api.conversationId, context);
      await conversation?.submit(
        { type: "input", content: CONTINUE_PROMPT, whenBusy: "steer", whenIdle: "reject", requestId: `context-continue:${api.taskId}`, entry: CONTINUE_ENTRY },
        context,
      ).catch((error: unknown) => console.warn(JSON.stringify({ t3flare: "context-continue-refused", error: String(error).slice(0, 300) })));
      return {
        output: [{ type: "text" as const, text: "Handoff saved. The new context starts from it after this tool round." }],
        details: { handoffCharacters: args.handoff.length, notes: notes.length },
        control: { handoff: handoffText(api.conversationId, args.handoff, notes) },
      };
    },
  });

/**
 * Automatic compaction as Rollover, in conversations that offer `context_rollover`:
 *
 * - A background threshold compaction is declined: it blocks nothing, and the request goes ahead with pi-durable's
 *   overflow recovery intact. While a run is live, the agent is asked once per Context Window, by a request steered after
 *   the current tool round, to update its Notes and roll over. With no run live it only declines; the next input crosses
 *   the threshold again and asks then.
 * - A blocking threshold compaction and an overflow compaction cannot wait for the agent: declining the blocking one
 *   would send a request without overflow recovery. Both are the Emergency Rollover, whose summary is the last saved
 *   Handoff and the Note Index, on pi-durable's cut.
 * - A manual compaction keeps pi-durable's summary.
 */
export const prepareRollover = (harness: () => Promise<Harness>): HookRegistration =>
  hook(CompactionTask, {
    beforeCompact: async (compaction, api, context: Context) => {
      if (compaction.reason === "manual") return undefined;
      const conversation = await (await harness()).conversation(api.conversationId, context);
      if (conversation === undefined) return undefined;
      const agent = await conversation.agent(context);
      if (!agent.tools.some((tool) => tool.name === "context_rollover")) return undefined;
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const blocking = live?.compactions?.find((status) => status.taskId === api.taskId)?.blocking ?? false;
      if (compaction.reason === "overflow" || blocking) {
        const state = (await api.snapshot(ContextDoc, api.conversationId, context)) ?? EMPTY_STATE;
        return { summary: emergencyText(api.conversationId, state.handoff, state.notes) };
      }
      if (live?.run === undefined) return { decline: true } as const;
      // The head of the current Context Window: one request per window, however often the threshold is crossed.
      const window = compaction.entries[0]?.id ?? compaction.firstKept;
      await conversation
        .submit(
          { type: "input", content: PREPARE_PROMPT, whenBusy: "steer", whenIdle: "reject", requestId: `${PREPARE_REQUEST}${window}`, entry: PREPARE_ENTRY },
          context,
        )
        // The run ended meanwhile: nothing to steer, and the next input asks again.
        .catch(() => undefined);
      return { decline: true } as const;
    },
  });
