// Adapted from cloudpid@93ba45a3:packages/extensions/src/context.ts (SPI-1056; parity row pi-context-management): the
// `context` extension, pi-context-management's `context_notes`, `context_history` and `context_rollover` on pi-durable.
// Notes are a conversation document in the Session DO's storage (bounded, `./context/notes.ts`), History reads the
// Session's stored entries, and Rollover hands off with `control: { handoff }`. With `rolloverOnCompaction` (the
// default), a `beforeCompact` hook turns a background threshold compaction into a Rollover request and a compaction that
// cannot wait into an Emergency Rollover (`./context/rollover.ts` says how it sits with pi-durable's and t3's
// compaction). In code mode the notes and history tools are the `context` namespace; `context_rollover` is the model's.
import { defineExtension, type Extension, type Harness, section } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";

import { contextRolloverTool, prepareRollover } from "./context/rollover.ts";
import { CONTEXT_GUIDELINES, contextHistoryTool, contextNotesTool } from "./context/tools.ts";

export const CONTEXT_EXTENSION = "context";

export { ContextDoc, type ContextState, MAX_NOTE_CHARACTERS, MAX_NOTES, MAX_TOTAL_NOTE_CHARACTERS } from "./context/notes.ts";

export const CONTEXT_NAMESPACE: CodemodeNamespace = { name: "context", description: "This thread's Notes and stored History", prefix: "context_" };

export interface ContextOptions {
  /** Turn automatic compaction into a Rollover (the harness setting); off: pi-durable summarizes as before. */
  readonly rolloverOnCompaction: boolean;
}

/** The `context` extension; `harness` finds the conversation a compaction belongs to. */
export const contextExtension = (harness: () => Promise<Harness>, options: ContextOptions): Extension =>
  defineExtension({
    name: CONTEXT_EXTENSION,
    tools: [contextNotesTool(), contextHistoryTool(), contextRolloverTool()],
    hooks: options.rolloverOnCompaction ? [prepareRollover(harness)] : [],
    // The guideline of each context tool the request offers, as pi-context-management adds them to the prompt.
    sections: [
      section("context_management", (input) => {
        const lines = Object.entries(CONTEXT_GUIDELINES).flatMap(([tool, line]) => (input.agent.tools.some((offered) => offered.name === tool) ? [`- ${line}`] : []));
        return lines.length === 0 ? undefined : lines.join("\n");
      }),
    ],
  });
