// @effect-diagnostics globalConsole:off
// The Console t3 runs with in the Environment DO (ADR-0010): nothing secret reaches Workers Logs.
//
// t3 prints a fresh one-time pairing URL, token included, on every boot (`announceStartupPairingUrl` in
// serverRuntimeStartup.ts, through `Console.log`), and Effect's loggers write through the same Console
// reference. This Console drops t3's pairing-URL line and redacts any `token=` value or bearer credential
// in what remains, before it reaches workerd's console.
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";

/** t3's pairing-URL line: `  pairingUrl: http://…/pair#token=…`. */
const PAIRING_LINE = /pairingUrl:/i;
const TOKEN_PARAM = /([#?&](?:token|credential)=)[^&\s"'#]+/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;

const SENSITIVE = /pairingUrl:|[#?&](?:token|credential)=|Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i;

export const redact = (text: string): string => text.replace(TOKEN_PARAM, "$1<redacted>").replace(BEARER, "$1<redacted>");

/** Counts what was dropped or redacted, for the admin health route. */
export const redactions = { droppedPairingLines: 0, redactedArguments: 0 };

const redactArgument = (value: unknown): unknown => {
  if (typeof value === "string") {
    const next = redact(value);
    if (next !== value) redactions.redactedArguments++;
    return next;
  }
  if (value !== null && typeof value === "object") {
    // Structured log records: redact their JSON form only when it holds something to redact.
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch {
      return value;
    }
    if (text === undefined || !SENSITIVE.test(text)) return value;
    redactions.redactedArguments++;
    return redact(text);
  }
  return value;
};

const PRINTING = new Set(["log", "info", "warn", "error", "debug", "trace", "dir", "dirxml", "table", "group", "groupCollapsed"]);

/** A console whose printing methods drop pairing lines and redact credentials. */
export const redactingConsole = (target: globalThis.Console = globalThis.console): Console.Console =>
  new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof property !== "string" || !PRINTING.has(property) || typeof value !== "function") {
        return typeof value === "function" ? value.bind(object) : value;
      }
      return (...args: Array<unknown>) => {
        if (args.some((arg) => typeof arg === "string" && PAIRING_LINE.test(arg))) {
          redactions.droppedPairingLines++;
          return;
        }
        (value as (...a: Array<unknown>) => void).apply(object, args.map(redactArgument));
      };
    },
  }) as unknown as Console.Console;

/** Provides the redacting Console to everything t3 builds. */
export const layer = Layer.succeed(Console.Console, redactingConsole());
