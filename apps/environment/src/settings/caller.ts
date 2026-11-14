// Who calls the Settings server, as the Environment derives it (ADR-0034, plan D3): the types the MCP host, the relay
// and the provider share with the server, kept apart so none of them imports the server itself (M3 review).

/** A thread's Linked work as the Environment establishes it. */
export type ThreadLink = "own" | "linked" | "unknown";

/** A calling thread's modes, from the Environment's own record. */
export interface ThreadModes {
  readonly runtimeMode: string | undefined;
  readonly interactionMode: string | undefined;
}

/**
 * t3flare's own agent calling, as the Environment derived it: its thread (undefined when the caller sent none: judged as
 * unknown work) and its agent kind (`piDurable`, or the CLI's name from the relay's tool handle). It comes through the
 * own agents' door (ADR-0034 §1; GLOSSARY: Door).
 */
export interface OwnCaller {
  readonly door: "own";
  readonly thread: string | undefined;
  readonly agent: string;
}

/** The answer to any call while the owner has the Settings server off (plan D2): the MCP host's and the server's. */
export const OFF_MESSAGE = "The owner turned the Settings server off; only the Harness panel turns it back on.";
