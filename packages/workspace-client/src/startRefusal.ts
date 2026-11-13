// A refused Container start's reason, whole (ADR-0032 §7: a refusal names the budget and where to change it). The
// Container budget's lease refusal is thrown inside computer's Container backend, which wraps it in its connect errors and
// keeps only the first 240 characters of each message, its own prefix included (fewer still after `priorExit=`), so the
// reason in the outer message may be cut. The whole one is the deepest cause carrying it; Workers RPC keeps an error's
// `cause`, so the chain reaches the Session and the Environment too. Every surface that turns such an error into text
// (a Durable agent's command, a terminal, a CLI process, git and checkpoint answers, worktree creation) goes through here.

/** How deep a cause chain is followed: computer nests two or three levels; a cycle must not loop forever. */
const MAX_CAUSE_DEPTH = 10;

/**
 * The reason after the budget's own prefix. It ends at a `"` because computer quotes an inner message inside its own
 * (`priorExit="…"`, JSON-quoted causes), and at the end of the text otherwise.
 */
const REFUSED = /the Container cannot start: (.+?)(?:"|$)/s;

/** The whole reason a start was refused for, from the deepest error in `error`'s cause chain that carries it. */
export const startRefusal = (error: unknown): string | undefined => {
  let found: string | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
    const text = current instanceof Error ? current.message : typeof current === "string" ? current : "";
    const reason = REFUSED.exec(text)?.[1];
    if (reason !== undefined) found = reason;
    current = current instanceof Error ? current.cause : undefined;
  }
  return found;
};

/** `error` as the text a person or an agent is shown: a refused start's whole reason, anything else as it is. */
export const describeFailure = (error: unknown): string => {
  const reason = startRefusal(error);
  return reason === undefined ? String(error) : `t3flare: the Container cannot start: ${reason}`;
};
