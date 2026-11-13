// A refused Container start's reason (the budget's, SPI-1149). computer wraps the lease's error in its connect errors and
// keeps only the first 240 characters of each message, its own prefix included (fewer still after `priorExit=`), so the
// reason in the outer message may be cut. The whole one is the innermost cause carrying it.

const REFUSED = /the Container cannot start: (.+?)(?:"|$)/s;

/** The whole reason a start was refused for, from the deepest error in `error`'s cause chain that carries it. */
export const startRefusal = (error: unknown): string | undefined => {
  let found: string | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current !== undefined && current !== null; depth++) {
    const text = current instanceof Error ? current.message : typeof current === "string" ? current : "";
    const reason = REFUSED.exec(text)?.[1];
    if (reason !== undefined) found = reason;
    current = current instanceof Error ? current.cause : undefined;
  }
  return found;
};
