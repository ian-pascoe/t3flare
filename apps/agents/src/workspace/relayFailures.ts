// The model relay's failed answers (SPI-1172): what goes back to the CLI, and what the relay reads of it.
//
// - An error answer's body goes back whole, redacted (`@t3flare/models/redact`, which keeps JSON valid), up to
//   `RELAY_ERROR_BODY_BYTES`. A larger one is not cut (a cut JSON body is no JSON a CLI can read): a short error in the
//   API's own shape takes its place, with the same status.
// - A stream that began with 200 may carry an error event (Anthropic's `error`, OpenAI's `error` or `response.failed`, a
//   Completions error chunk, Mistral's `conversation.response.error`): `sseErrors` passes the stream through as it
//   comes, piece by piece, holding only a line that opens as such an event, which it redacts and reports at its end.
import type { EndpointApi } from "@t3flare/models/endpoints";
import type { EndpointFailureRecord } from "@t3flare/session-protocol";

/** The largest error body the relay redacts and passes back; past it, `oversizedError`. */
export const RELAY_ERROR_BODY_BYTES = 1024 * 1024;

/** A short error in the API's own shape, in place of an error body over `RELAY_ERROR_BODY_BYTES`. */
export const oversizedError = (api: EndpointApi, status: number): string =>
  relayErrorBody(api, status, `t3flare: the Model endpoint's error body (HTTP ${status}) was over ${RELAY_ERROR_BODY_BYTES} bytes and was not passed on`);

/**
 * The relay's own error in the API's own shape, so the CLI shows `message` as it would a vendor's (an oversized body's
 * stand-in; a sign-in's refusal, SPI-1171). A 401 is Anthropic's `authentication_error`.
 */
export const relayErrorBody = (api: EndpointApi, status: number, message: string): string => {
  const server = status >= 500;
  switch (api) {
    case "anthropic-messages":
      return JSON.stringify({ type: "error", error: { type: server ? "api_error" : status === 401 ? "authentication_error" : "invalid_request_error", message } });
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

/** A stream event that is an error: as an error body the classifier reads, and the status it carries, if any. */
export interface StreamError {
  readonly body: string;
  readonly status?: number;
}

/**
 * A stream event's error, or undefined for an event that is no error: Anthropic's `{"type":"error","error":{…}}`,
 * OpenAI Responses' `{"type":"error","code","message"}` and `{"type":"response.failed","response":{"error":{…}}}`, an
 * OpenAI-compatible Completions chunk that is only an error (`{"error":{…}}`, no `type`), and Mistral Conversations'
 * `{"type":"conversation.response.error","message","code"}` (mistralai/client-python `ResponseErrorEvent`, read
 * 2026-11-16), whose numeric `code` is taken as its status.
 */
export const streamErrorBody = (data: string): StreamError | undefined => {
  if (!data.includes("error") && !data.includes("failed")) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(event)) return undefined;
  if (event.type === "error" && isRecord(event.error)) return { body: data };
  if (event.type === undefined && isRecord(event.error)) return { body: data };
  if (event.type === "error") return { body: JSON.stringify({ error: { code: event.code ?? null, message: event.message ?? null, type: event.type } }) };
  if (event.type === "response.failed" && isRecord(event.response) && isRecord(event.response.error)) return { body: JSON.stringify({ error: event.response.error }) };
  if (event.type === "conversation.response.error") {
    const code = typeof event.code === "number" && event.code >= 400 && event.code < 600 ? event.code : undefined;
    return { body: JSON.stringify({ error: { message: event.message ?? null, type: event.type } }), ...(code === undefined ? {} : { status: code }) };
  }
  return undefined;
};

/**
 * The openings of a `data:` line whose event may be an error, compared with the line's whitespace taken out (so
 * `data:  { "type": "error"` is one): Anthropic's and OpenAI Responses' `error`, Responses' `response.failed`, a
 * Completions chunk's `{"error"`, Mistral's `conversation.response.error`. Each names its `type` (or `error`) as the
 * object's first key, as every vendor sends it; a line that opens otherwise is no error event and goes on as it comes.
 */
const ERROR_OPENINGS = ['data:{"type":"error"', 'data:{"type":"response.failed"', 'data:{"error"', 'data:{"type":"conversation.response.error"'];

/**
 * A stream passed through as it comes (SPI-1173's usage reader and the CLI never wait for a line's end), but for a line
 * that opens as an error event (`ERROR_OPENINGS`): that line is held to its end, redacted (`redact`) and reported
 * (`onError`, awaited before the line goes on). A line is held only while its opening could still be one of them; once
 * a line is passing, the rest of it passes, whatever it holds. A line ends at `\n` (a `\r` before it stays in it).
 */
export const sseErrors = (redact: (text: string) => string, onError: (error: StreamError) => Promise<void> | void): TransformStream<Uint8Array, Uint8Array> => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  /** The current line's text not yet passed on, and whether it is passing (decided not to be an error event). */
  let held = "";
  let passing = false;
  /** Whether `text`, the start of a line, could still open an error event, or does (its whitespace out). */
  const mayBeError = (text: string) => {
    const squeezed = text.replace(/\s+/g, "");
    return ERROR_OPENINGS.some((opening) => opening.startsWith(squeezed) || squeezed.startsWith(opening));
  };
  /** A complete held line as it goes on: an error event's redacted, after its report. */
  const finished = async (text: string): Promise<string> => {
    const error = text.startsWith("data:") ? streamErrorBody(text.slice(5).trim()) : undefined;
    if (error === undefined) return text;
    await onError(error);
    return redact(text);
  };
  const take = async (text: string): Promise<string> => {
    let out = "";
    let rest = text;
    while (rest !== "") {
      const end = rest.indexOf("\n");
      const piece = end === -1 ? rest : rest.slice(0, end);
      rest = end === -1 ? "" : rest.slice(end + 1);
      if (passing) out += piece;
      else {
        held += piece;
        if (!mayBeError(held)) {
          passing = true;
          out += held;
          held = "";
        }
      }
      if (end === -1) break;
      // The line ends: a held one is finished, and the next line starts undecided.
      if (!passing) out += await finished(held);
      out += "\n";
      held = "";
      passing = false;
    }
    return out;
  };
  return new TransformStream({
    transform: async (chunk, controller) => {
      const out = await take(decoder.decode(chunk, { stream: true }));
      if (out !== "") controller.enqueue(encoder.encode(out));
    },
    flush: async (controller) => {
      const out = (await take(decoder.decode())) + (passing || held === "" ? "" : await finished(held));
      if (out !== "") controller.enqueue(encoder.encode(out));
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
 * What it cannot tell apart (U80): a background request's stop during the turn becomes the record, and a stop the CLI
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
