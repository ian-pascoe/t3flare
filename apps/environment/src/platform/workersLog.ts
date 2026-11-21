/**
 * One structured Workers log line: `console[level](JSON.stringify(fields))`. Its JSON shape (`t3flare` names the event)
 * is what the logs are queried by. Callers pass plain data, so stringify cannot throw.
 */
export const workersLog = (level: "log" | "warn" | "error", fields: { readonly t3flare: string } & Record<string, unknown>): void => {
  console[level](JSON.stringify(fields));
};
