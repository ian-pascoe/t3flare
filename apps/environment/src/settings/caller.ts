// Who calls the Settings server, as the Environment derives it (ADR-0035, plan D3): the types the MCP host, the relay
// and the provider share with the server, kept apart so none of them imports the server itself (SPI-1198 review).

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
 * own agents' door (ADR-0035 §1; GLOSSARY: Door).
 */
export interface OwnCaller {
  readonly door: "own";
  readonly thread: string | undefined;
  readonly agent: string;
}

/**
 * An Owner client calling the Owner-client endpoint (plan D11, M5a): who Access admitted, as the Worker verified it. `key`
 * is the caps' key: the Access `sub`, or `service-token`. `client` is the client's own label, display only and never
 * trusted.
 */
export interface OwnerCaller {
  readonly door: "owner";
  readonly kind: "owner" | "service-token";
  readonly key: string;
  readonly client?: { readonly name: string; readonly source: string };
}

/** The answer to any call while the owner has the Settings server off (plan D2): the MCP host's and the server's. */
export const OFF_MESSAGE = "The owner turned the Settings server off; only the Harness panel turns it back on.";
