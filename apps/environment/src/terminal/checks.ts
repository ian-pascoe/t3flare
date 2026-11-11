// Step 2b's admin checks on t3's TerminalManager (loaded only by the admin route, after t3 booted).
import * as Effect from "effect/Effect";
import * as TerminalManager from "t3/src/terminal/Manager.ts";

/** t3's `closeIdle` for a thread, as its settlement runs it (review F1): a terminal whose foreground runs a command stays. */
export const closeIdleFor = Effect.fn("t3flare.closeIdleFor")(function* (threadId: string) {
  const terminals = yield* TerminalManager.TerminalManager;
  yield* terminals.closeIdle({ threadId });
  return { closeIdle: "ran", threadId };
});
