// The model relay's failed answers (SPI-1172): what goes back to the CLI, and what the relay reads of it.
//
// - An error answer's body goes back whole, redacted (`@t3flare/models/redact`, which keeps JSON valid), up to
//   `RELAY_ERROR_BODY_BYTES`. A larger one is not cut (a cut JSON body is no JSON a CLI can read): a short error in the
//   API's own shape takes its place, with the same status.
// - A stream that began with 200 may carry an error event (Anthropic's `error`, OpenAI's `error` or `response.failed`):
//   `sseErrors` passes the stream through as it comes, line by line, and redacts and reports each such event's line.
import type { EndpointApi } from "@t3flare/models/endpoints";
import type { EndpointFailureRecord } from "@t3flare/session-protocol";

/** The largest error body the relay redacts and passes back; past it, `oversizedError`. */
export const RELAY_ERROR_BODY_BYTES = 1024 * 1024;

/** A short error in the API's own shape, in place of an error body over `RELAY_ERROR_BODY_BYTES`. */
export const oversizedError = (api: EndpointApi, status: number): string => {
  const message = `t3flare: the Model endpoint's error body (HTTP ${status}) was over ${RELAY_ERROR_BODY_BYTES} bytes and was not passed on`;
  return api === "anthropic-messages"
    ? JSON.stringify({ type: "error", error: { type: status >= 500 ? "api_error" : "invalid_request_error", message } })
    : JSON.stringify({ error: { message, type: status >= 500 ? "server_error" : "invalid_request_error", param: null, code: null } });
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A stream event's error as an error body the classifier reads (`{"error": {…}}`, or Anthropic's own shape), or
 * undefined for an event that is no error: Anthropic's `{"type":"error","error":{…}}`, OpenAI's `{"type":"error","code",
 * "message"}` and `{"type":"response.failed","response":{"error":{…}}}`.
 */
export const streamErrorBody = (data: string): string | undefined => {
  if (!data.includes("error") && !data.includes("failed")) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(event)) return undefined;
  if (event.type === "error" && isRecord(event.error)) return data;
  if (event.type === "error") return JSON.stringify({ error: { code: event.code ?? null, message: event.message ?? null, type: event.type } });
  if (event.type === "response.failed" && isRecord(event.response) && isRecord(event.response.error)) return JSON.stringify({ error: event.response.error });
  return undefined;
};

/**
 * A stream's bytes passed through as they come, a line at a time: a `data:` line holding an error event is redacted
 * (`redact`) and reported (`onError`, with the event as an error body). Every other byte goes on unchanged; a line's end
 * is awaited before it goes on, and what is left at the stream's end is flushed.
 */
export const sseErrors = (redact: (text: string) => string, onError: (body: string) => void): TransformStream<Uint8Array, Uint8Array> => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const line = (text: string): string => {
    if (!text.startsWith("data:")) return text;
    const body = streamErrorBody(text.slice(5).trim());
    if (body === undefined) return text;
    onError(body);
    return redact(text);
  };
  return new TransformStream({
    transform: (chunk, controller) => {
      pending += decoder.decode(chunk, { stream: true });
      const end = pending.lastIndexOf("\n");
      if (end === -1) return;
      const complete = pending.slice(0, end + 1);
      pending = pending.slice(end + 1);
      controller.enqueue(encoder.encode(complete.split("\n").map(line).join("\n")));
    },
    flush: (controller) => {
      pending += decoder.decode();
      if (pending !== "") controller.enqueue(encoder.encode(line(pending)));
    },
  });
};

/**
 * Each CLI process's last model relay failure this turn (the Workspace DO's, in memory): the relay reports every answer
 * (a success clears it), a turn's start forgets it, and the Environment's CLI wrapper reads it when the turn fails.
 */
export class RelayFailures {
  readonly #byProcess = new Map<string, EndpointFailureRecord>();

  /** The relay's report of an answer: its classified failure, or null for a success or one the table does not know. */
  report(processKey: string, failure: EndpointFailureRecord | null): void {
    if (failure === null) this.#byProcess.delete(processKey);
    else this.#byProcess.set(processKey, failure);
  }

  /** A turn of the process starts: an earlier turn's failure is never read for it. */
  turnStarted(processKey: string): void {
    this.#byProcess.delete(processKey);
  }

  last(processKey: string): EndpointFailureRecord | null {
    return this.#byProcess.get(processKey) ?? null;
  }
}
