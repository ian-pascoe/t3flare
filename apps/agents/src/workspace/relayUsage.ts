// The model relay's usage reader (SPI-1173): a relayed CLI request's usage, read from its answer as it streams past, for
// t3flare's own usage records (`@t3flare/models/usage`). Each piece of the answer goes on to the CLI first, then a copy
// is read: a stream line by line (the event that carries the usage), a JSON body whole once it has ended. Nothing waits
// on the reader, and nothing it does can break the answer: a failure stops the reading, never the stream. What it keeps
// is the usage's counts and the model's name; the answer's text is dropped as it is read.
//
// Per API, the usage is where the vendor puts it:
// - Anthropic Messages: `message_start`'s message (model, input and cache) and the last `message_delta` (output); a body's
//   own `usage`.
// - OpenAI Responses: the final `response.completed` (or `.incomplete`, `.failed`) event's response; a body's `usage`.
//   `input_tokens` includes the cached ones.
// - Chat Completions (OpenCode, pi): the last chunk's `usage` (with `stream_options.include_usage`); a body's `usage`.
// - Google: every chunk's `usageMetadata`, cumulative (thoughts are counted apart from the candidates); a streamed answer
//   without `alt=sse` is one JSON array.
// - Mistral: the `conversation.response.done` event's usage (Conversations), or Chat Completions' shape.
import type { EndpointApi } from "@t3flare/models/endpoints";
import { isUsageAgent, tokenCount, type UsageAgent, type UsageEntry, usageEntryOf, type UsageTokens } from "@t3flare/models/usage";

/** The longest stream line, or JSON body, the reader copies: past it, it stops reading (the answer still goes through). */
export const MAX_USAGE_COPY_CHARS = 4 * 1024 * 1024;

/** What the relay knows of a request when its answer starts. */
export interface RelayCall {
  /** The process's CLI (`HandleCaller.cli`); a process that is not a CLI agent's is not recorded. */
  readonly cli: string;
  readonly endpointId: string;
  readonly api: EndpointApi;
  /** The model's own id, when the request named it to the relay (a model-routed request); else the answer's. */
  readonly modelId: string | null;
  /** The process's key: one CLI session. */
  readonly session: string;
  readonly at: number;
}

/** The answer's counts so far, and the model it names. */
type Counts = { -readonly [K in keyof UsageTokens]: UsageTokens[K] } & { model: string | null };

type Json = Record<string, unknown>;

const object = (value: unknown): Json | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined);
/** A vendor's count, or undefined when it gives none (so the count it gave earlier stands). */
const num = (value: unknown): number | undefined => (typeof value === "number" ? tokenCount(value) : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** A stream's counts are cumulative: a later event's count replaces the earlier, and an event without one leaves it. */
const put = (counts: Counts, field: keyof UsageTokens, value: number | undefined) => {
  if (value !== undefined) counts[field] = value;
};

const nameModel = (counts: Counts, value: unknown) => {
  const model = text(value);
  if (model !== undefined) counts.model = model;
};

const anthropicUsage = (counts: Counts, usage: Json | undefined) => {
  if (usage === undefined) return;
  put(counts, "input", num(usage.input_tokens));
  put(counts, "cacheRead", num(usage.cache_read_input_tokens));
  put(counts, "cacheWrite", num(usage.cache_creation_input_tokens));
  put(counts, "output", num(usage.output_tokens));
};

/** OpenAI's shapes, whose input counts include the cached tokens. */
const promptUsage = (counts: Counts, input: number | undefined, cached: number | undefined, output: number | undefined, reasoning: number | undefined) => {
  if (input !== undefined) put(counts, "input", Math.max(0, input - (cached ?? 0)));
  put(counts, "cacheRead", cached);
  put(counts, "output", output);
  put(counts, "reasoning", reasoning);
};

const responsesUsage = (counts: Counts, usage: Json | undefined) => {
  if (usage === undefined) return;
  promptUsage(counts, num(usage.input_tokens), num(object(usage.input_tokens_details)?.cached_tokens), num(usage.output_tokens), num(object(usage.output_tokens_details)?.reasoning_tokens));
};

const completionsUsage = (counts: Counts, usage: Json | undefined) => {
  if (usage === undefined) return;
  promptUsage(counts, num(usage.prompt_tokens), num(object(usage.prompt_tokens_details)?.cached_tokens), num(usage.completion_tokens), num(object(usage.completion_tokens_details)?.reasoning_tokens));
};

const googleUsage = (counts: Counts, usage: Json | undefined) => {
  if (usage === undefined) return;
  const prompt = num(usage.promptTokenCount);
  const cached = num(usage.cachedContentTokenCount);
  const thoughts = num(usage.thoughtsTokenCount);
  const candidates = num(usage.candidatesTokenCount);
  if (prompt !== undefined) put(counts, "input", Math.max(0, prompt - (cached ?? 0)));
  put(counts, "cacheRead", cached);
  if (candidates !== undefined || thoughts !== undefined) put(counts, "output", (candidates ?? 0) + (thoughts ?? 0));
  put(counts, "reasoning", thoughts);
};

/** What one parsed event or body says, by the endpoint's API. */
const readValue = (api: EndpointApi, counts: Counts, value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) readValue(api, counts, item);
    return;
  }
  const event = object(value);
  if (event === undefined) return;
  switch (api) {
    case "anthropic-messages": {
      if (event.type === "message_start") {
        const message = object(event.message);
        nameModel(counts, message?.model);
        anthropicUsage(counts, object(message?.usage));
      } else if (event.type === "message_delta" || event.type === "message") {
        nameModel(counts, event.model);
        anthropicUsage(counts, object(event.usage));
      }
      return;
    }
    case "openai-responses": {
      const response = typeof event.type === "string" && event.type.startsWith("response.") ? object(event.response) : event.object === "response" ? event : undefined;
      nameModel(counts, response?.model);
      responsesUsage(counts, object(response?.usage));
      return;
    }
    case "openai-completions": {
      nameModel(counts, event.model);
      completionsUsage(counts, object(event.usage));
      return;
    }
    case "google-generative-ai": {
      nameModel(counts, event.modelVersion);
      googleUsage(counts, object(event.usageMetadata));
      return;
    }
    case "mistral-conversations": {
      nameModel(counts, event.model);
      completionsUsage(counts, object(event.usage));
      return;
    }
  }
};

/** The agent a CLI process records under, or undefined for a process that is not a CLI agent's. */
const agentOf = (cli: string): UsageAgent | undefined => (isUsageAgent(cli) && cli !== "durable" && cli !== "text-generation" ? cli : undefined);

/** A copy of an answer's text, read as it passes: by line (a stream) or whole (a JSON body). */
class Reader {
  readonly #decoder = new TextDecoder();
  readonly #pending: Array<string> = [];
  #pendingChars = 0;
  #dead = false;
  readonly api: EndpointApi;
  readonly stream: boolean;
  /** The answer's own counts, and the model it names. */
  readonly counts: Counts = { model: null, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };

  constructor(api: EndpointApi, stream: boolean) {
    this.api = api;
    this.stream = stream;
  }

  get dead(): boolean {
    return this.#dead;
  }

  /** Stops reading: the answer goes on unread. */
  stop(): void {
    this.#dead = true;
    this.#pending.length = 0;
  }

  push(bytes: Uint8Array): void {
    if (this.#dead) return;
    this.#take(this.#decoder.decode(bytes, { stream: true }));
  }

  end(): void {
    if (this.#dead) return;
    this.#take(this.#decoder.decode());
    const rest = this.#pending.join("");
    this.#pending.length = 0;
    if (this.stream) this.#line(rest);
    else if (rest.trim() !== "") readValue(this.api, this.counts, JSON.parse(rest));
  }

  #take(chunk: string): void {
    if (!this.stream) return this.#hold(chunk);
    let start = 0;
    for (let newline = chunk.indexOf("\n"); newline !== -1; newline = chunk.indexOf("\n", start)) {
      const piece = chunk.slice(start, newline);
      if (this.#pendingChars + piece.length > MAX_USAGE_COPY_CHARS) return this.stop();
      const line = this.#pending.length === 0 ? piece : [...this.#pending, piece].join("");
      this.#pending.length = 0;
      this.#pendingChars = 0;
      start = newline + 1;
      this.#line(line);
    }
    this.#hold(chunk.slice(start));
  }

  #hold(piece: string): void {
    if (piece === "") return;
    this.#pendingChars += piece.length;
    if (this.#pendingChars > MAX_USAGE_COPY_CHARS) return this.stop();
    this.#pending.push(piece);
  }

  /** One stream line: a `data:` line whose JSON may hold usage is parsed; a line that does not parse is skipped. */
  #line(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    // Only an event that may name the usage or the model is parsed: text deltas are skipped unparsed.
    if (data === "" || data === "[DONE]" || !(data.includes('"usage') || data.includes('"model'))) return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    readValue(this.api, this.counts, value);
  }
}

/**
 * The answer's body with its usage read as it passes, recorded once it ends; the body itself when the answer is not one
 * whose usage can be read (a failure, a body neither a stream nor JSON, a process that is not a CLI agent's). A stream
 * the CLI cancels, or that fails, is recorded with the counts read so far (Anthropic's input is in its first event), once.
 */
export const observeUsage = (response: Response, call: RelayCall, record: (entry: UsageEntry) => void): ReadableStream<Uint8Array> | null => {
  const body = response.body;
  const agent = agentOf(call.cli);
  if (body === null || agent === undefined || response.status < 200 || response.status >= 300) return body;
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  const stream = type.includes("text/event-stream");
  if (!stream && !type.includes("json")) return body;
  const reader = new Reader(call.api, stream);
  const guarded = (work: () => void) => {
    if (reader.dead) return;
    try {
      work();
    } catch {
      reader.stop();
    }
  };
  let recorded = false;
  /** Records what was read, once: at the end, or what a cut stream had (never a cut JSON body: it does not parse). */
  const finish = (whole: boolean) => {
    if (recorded) return;
    recorded = true;
    guarded(() => {
      if (whole) reader.end();
      else if (!stream) return;
      const { model: named, ...tokens } = reader.counts;
      // The id the request named wins over the answer's (which may be a dated version of it).
      const model = call.modelId ?? named;
      if (model === null) return;
      const entry = usageEntryOf({ agent, endpointId: call.endpointId, modelId: model, at: call.at, session: call.session, ...tokens, costUsd: null });
      if (entry !== undefined) record(entry);
    });
  };
  const upstream = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await upstream.read();
      } catch (error) {
        finish(false);
        controller.error(error);
        return;
      }
      if (next.done) {
        controller.close();
        finish(true);
        return;
      }
      // The CLI's bytes first; the copy is read after.
      controller.enqueue(next.value);
      guarded(() => reader.push(next.value));
    },
    cancel(reason) {
      finish(false);
      return upstream.cancel(reason);
    },
  });
};
