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
  const server = status >= 500;
  switch (api) {
    case "anthropic-messages":
      return JSON.stringify({ type: "error", error: { type: server ? "api_error" : "invalid_request_error", message } });
    case "openai-responses":
    case "openai-completions":
      return JSON.stringify({ error: { message, type: server ? "server_error" : "invalid_request_error", param: null, code: null } });
    case "google-generative-ai":
      // Google's `google.rpc.Status` error (ai.google.dev/api/rest, "Errors").
      return JSON.stringify({ error: { code: status, message, status: server ? "INTERNAL" : "INVALID_ARGUMENT" } });
    case "mistral-conversations":
      // Mistral's error object (docs.mistral.ai, API errors): `object: "error"` beside OpenAI's fields.
      return JSON.stringify({ object: "error", message, type: server ? "internal_server_error" : "invalid_request_error", param: null, code: String(status) });
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A stream event's error as an error body the classifier reads (`{"error": {…}}`, or Anthropic's own shape), or
 * undefined for an event that is no error: Anthropic's `{"type":"error","error":{…}}`, OpenAI Responses'
 * `{"type":"error","code","message"}` and `{"type":"response.failed","response":{"error":{…}}}`, and an OpenAI-compatible
 * Completions chunk that is only an error (`{"error":{…}}`, no `type`).
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
  if (event.type === undefined && isRecord(event.error)) return data;
  if (event.type === "error") return JSON.stringify({ error: { code: event.code ?? null, message: event.message ?? null, type: event.type } });
  if (event.type === "response.failed" && isRecord(event.response) && isRecord(event.response.error)) return JSON.stringify({ error: event.response.error });
  return undefined;
};

/**
 * A stream's bytes passed through as they come, a line at a time: a `data:` line holding an error event is redacted
 * (`redact`) and reported (`onError`, with the event as an error body). Every other byte goes on unchanged; a line's end
 * is awaited before it goes on, and what is left at the stream's end is flushed.
 */
export const sseErrors = (redact: (text: string) => string, onError: (body: string) => Promise<void> | void): TransformStream<Uint8Array, Uint8Array> => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  /** A line as it goes on: an error event's redacted, after its report. */
  const line = async (text: string): Promise<string> => {
    if (!text.startsWith("data:")) return text;
    const body = streamErrorBody(text.slice(5).trim());
    if (body === undefined) return text;
    await onError(body);
    return redact(text);
  };
  const lines = async (text: string): Promise<string> => {
    const out: Array<string> = [];
    for (const each of text.split("\n")) out.push(await line(each));
    return out.join("\n");
  };
  return new TransformStream({
    transform: async (chunk, controller) => {
      pending += decoder.decode(chunk, { stream: true });
      const end = pending.lastIndexOf("\n");
      if (end === -1) return;
      const complete = pending.slice(0, end + 1);
      pending = pending.slice(end + 1);
      controller.enqueue(encoder.encode(await lines(complete)));
    },
    flush: async (controller) => {
      pending += decoder.decode();
      if (pending !== "") controller.enqueue(encoder.encode(await line(pending)));
    },
  });
};

/**
 * How telling a failure is for its turn: a stop (a usage limit, a spend limit, a refused key: no retry clears it) over
 * a passing one (an overload, a short rate limit: retried, and likely cleared by the next answer).
 */
const weight = (failure: EndpointFailureRecord): number => (failure.stop ? 2 : 1);

/**
 * Each CLI process's most telling model relay failure this turn (the Workspace DO's, in memory), which the
 * Environment's CLI wrapper reads when the turn fails. A process's requests are not all its turn's own: a CLI also asks
 * for a title or a summary on a small model. So:
 *
 * - a failure replaces the record unless the record is a stop and the failure only a passing one (a background
 *   request's overload never hides the turn's usage limit; a later stop does replace an earlier one);
 * - a success, an error the table does not know, or the relay's own failure (unreachable, a redirect) clears only a
 *   passing failure: a background request's 200 never clears the turn's usage limit, and a retried overload that then
 *   succeeded is forgotten;
 * - a turn's start forgets it, so a turn never reads an earlier turn's.
 *
 * What it cannot tell apart (U79): a background request's stop during the turn becomes the record, and a stop the CLI
 * later got past (its own retry after a reset) stays until the turn ends.
 */
export class RelayFailures {
  readonly #byProcess = new Map<string, EndpointFailureRecord>();

  /** The relay's report of an answer: its classified failure, or null for a success, an unknown error or its own failure. */
  report(processKey: string, failure: EndpointFailureRecord | null): void {
    const current = this.#byProcess.get(processKey);
    if (failure === null) {
      if (current !== undefined && weight(current) === 1) this.#byProcess.delete(processKey);
      return;
    }
    if (current === undefined || weight(failure) >= weight(current)) this.#byProcess.set(processKey, failure);
  }

  /** The process's turn starts (`active`) or ends: a start forgets an earlier turn's failure. */
  turn(processKey: string, active: boolean): void {
    if (active) this.#byProcess.delete(processKey);
  }

  last(processKey: string): EndpointFailureRecord | null {
    return this.#byProcess.get(processKey) ?? null;
  }
}
