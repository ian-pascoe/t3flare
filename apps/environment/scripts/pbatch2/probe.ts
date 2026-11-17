// @effect-diagnostics globalDate:off globalTimers:off
// Parity batch 2's probe Worker (test stages only, `t3flare-probe-<stage>`, made when T3FLARE_PROBE=1): throwaway
// receivers the stage's Environment is pointed at, each logging what it got to a Durable Object the harness reads.
//
// - An OTLP/HTTP receiver (`/v1/traces`, `/v1/metrics`, `/v1/logs`, JSON): it keeps each export's size, service name and
//   a sample of span and metric names.
//
// - SPI-1167: a stand-in Model endpoint at `/relay/v1` for the model relay, admitted only with the probe key as its
//   bearer (the key the endpoint is saved with). It logs each request's path, whether the key came, and every other
//   header (so the harness can look for a model handle that should never arrive). `/relay/v1/drip?gaps=30,60,…` answers
//   a server-sent event stream with an event at the start and after each gap (seconds): the long, idle stream check.
//   `/relay/v1/chat/completions` (SPI-1173) answers any Chat Completions request with "ready" as a stream (or a body
//   when `stream` is false), its usage in the last chunk, under the model the request named: a Model endpoint keyed
//   with a key of its own, for the usage records. `/relay/v1/messages` (Anthropic Messages) and `/relay/v1/responses`
//   (OpenAI Responses) do the same in their APIs' stream shapes; a Messages model named `slow-…` sends its first event
//   and then waits a minute, so a client that hangs up mid-stream can be seen. Both send subscription windows in their
//   vendor's limit headers (SPI-1174), for the limit meters.
//
// `GET /log` (with the probe key as bearer) answers everything logged.
import { DurableObject } from "cloudflare:workers";

interface LogStub {
  append(entry: unknown): Promise<number>;
  entries(): Promise<Array<unknown>>;
}

interface Env {
  readonly PROBE_KEY: string;
  readonly LOG: { idFromName(name: string): unknown; get(id: unknown): LogStub };
}

export class ProbeLog extends DurableObject {
  async append(entry: unknown): Promise<number> {
    const entries = ((await this.ctx.storage.get<Array<unknown>>("entries")) ?? []).slice(-499);
    entries.push(entry);
    await this.ctx.storage.put("entries", entries);
    return entries.length;
  }
  async entries(): Promise<Array<unknown>> {
    return (await this.ctx.storage.get<Array<unknown>>("entries")) ?? [];
  }
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

/** What an OTLP/JSON export held: its service, its span or metric names (a sample), its counts. */
const summarize = (signal: string, body: any) => {
  const resources: Array<any> = body?.resourceSpans ?? body?.resourceMetrics ?? body?.resourceLogs ?? [];
  const service = resources
    .flatMap((r: any) => r?.resource?.attributes ?? [])
    .find((a: any) => a?.key === "service.name")?.value?.stringValue;
  const names = new Set<string>();
  let count = 0;
  for (const r of resources) {
    for (const scope of r?.scopeSpans ?? r?.scopeMetrics ?? r?.scopeLogs ?? []) {
      for (const item of scope?.spans ?? scope?.metrics ?? scope?.logRecords ?? []) {
        count += 1;
        if (typeof item?.name === "string" && names.size < 25) names.add(item.name);
      }
    }
  }
  return { signal, service, count, names: [...names] };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const log = env.LOG.get(env.LOG.idFromName("log"));
    const authorization = request.headers.get("authorization");

    if (url.pathname === "/log" && request.method === "GET") {
      return authorization === `Bearer ${env.PROBE_KEY}` ? json(await log.entries()) : json({ error: "unauthorized" }, 401);
    }

    if (url.pathname.startsWith("/relay/v1/")) {
      // A bearer (OpenAI's APIs), or Anthropic's `x-api-key` (SPI-1173's Messages stand-in).
      const sawKey = authorization === `Bearer ${env.PROBE_KEY}` || request.headers.get("x-api-key") === env.PROBE_KEY;
      const requestNumber = await log.append({
        at: new Date().toISOString(),
        kind: "relay",
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        sawKey,
        headers: Object.fromEntries([...request.headers].filter(([name]) => name !== "authorization")),
      });
      if (!sawKey) return json({ error: { message: "the stand-in endpoint wants its key" } }, 401);
      if (url.pathname === "/relay/v1/models") return json({ object: "list", data: [{ id: "drip", object: "model" }] });
      // SPI-1174: each answer reports subscription windows in its vendor's limit headers (Claude's unified ones on
      // Messages, ChatGPT's Codex ones on Responses), the share used growing with each request, the resets fixed ahead.
      const nowS = Math.floor(Date.now() / 1000);
      const used = 5 + (requestNumber % 90);
      if (url.pathname === "/relay/v1/messages" && request.method === "POST") {
        const limits = {
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": String(used / 100),
          "anthropic-ratelimit-unified-5h-reset": String(nowS + 2 * 3600),
          "anthropic-ratelimit-unified-7d-status": "allowed",
          "anthropic-ratelimit-unified-7d-utilization": "0.3",
          "anthropic-ratelimit-unified-7d-reset": String(nowS + 3 * 86400),
        };
        const asked = (await request.json().catch(() => ({}))) as { model?: unknown; stream?: unknown };
        const model = typeof asked.model === "string" ? asked.model : "standin";
        const usage = { input_tokens: 1000, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 };
        const message = { id: "msg_standin", type: "message", role: "assistant", model, content: [] as Array<unknown>, stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } };
        if (asked.stream !== true) {
          return Response.json({ ...message, content: [{ type: "text", text: "ready" }], stop_reason: "end_turn", usage: { ...usage, output_tokens: 3 } }, { headers: { "cache-control": "no-store", ...limits } });
        }
        const event = (data: { readonly type: string }) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(event({ type: "message_start", message } as { type: string })));
            if (model.startsWith("slow-")) await new Promise((resolve) => setTimeout(resolve, 60_000));
            for (const data of [
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ready" } },
              { type: "content_block_stop", index: 0 },
              { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
              { type: "message_stop" },
            ]) {
              controller.enqueue(encoder.encode(event(data)));
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...limits } });
      }
      if (url.pathname === "/relay/v1/responses" && request.method === "POST") {
        const limits = {
          "x-codex-primary-used-percent": String(used),
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-at": String(nowS + 2 * 3600),
          "x-codex-secondary-used-percent": "30",
          "x-codex-secondary-window-minutes": "10080",
          "x-codex-secondary-reset-at": String(nowS + 3 * 86400),
        };
        const asked = (await request.json().catch(() => ({}))) as { model?: unknown };
        const model = typeof asked.model === "string" ? asked.model : "standin";
        const item = { id: "msg_standin", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ready", annotations: [] }] };
        const response = { id: "resp_standin", object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "in_progress", output: [] as Array<unknown> };
        const usage = { input_tokens: 1500, input_tokens_details: { cached_tokens: 500 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1504 };
        const events = [
          { type: "response.created", sequence_number: 0, response },
          { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...item, status: "in_progress", content: [] } },
          { type: "response.output_text.delta", sequence_number: 2, item_id: item.id, output_index: 0, content_index: 0, delta: "ready" },
          { type: "response.output_item.done", sequence_number: 3, output_index: 0, item },
          { type: "response.completed", sequence_number: 4, response: { ...response, status: "completed", output: [item], usage } },
        ];
        return new Response(events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...limits } });
      }
      if (url.pathname === "/relay/v1/chat/completions" && request.method === "POST") {
        const asked = (await request.json().catch(() => ({}))) as { model?: unknown; stream?: unknown };
        const model = typeof asked.model === "string" ? asked.model : "standin";
        const usage = { prompt_tokens: 1200, completion_tokens: 3, total_tokens: 1203, prompt_tokens_details: { cached_tokens: 200 } };
        const base = { id: "chatcmpl-standin", created: Math.floor(Date.now() / 1000), model };
        if (asked.stream === false) {
          return json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ready" }, finish_reason: "stop" }], usage });
        }
        const chunks = [
          { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ready" }, finish_reason: null }] },
          { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { ...base, object: "chat.completion.chunk", choices: [], usage },
        ];
        const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
        return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }
      if (url.pathname === "/relay/v1/drip") {
        const gaps = (url.searchParams.get("gaps") ?? "1")
          .split(",")
          .map(Number)
          .filter((gap) => Number.isFinite(gap) && gap >= 0 && gap <= 900);
        const encoder = new TextEncoder();
        const started = Date.now();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const event = (n: number) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ n, s: Math.round((Date.now() - started) / 1000) })}\n\n`));
            event(0);
            for (const [at, gap] of gaps.entries()) {
              await new Promise((resolve) => setTimeout(resolve, gap * 1000));
              event(at + 1);
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            await log.append({ at: new Date().toISOString(), kind: "relay-drip-done", seconds: Math.round((Date.now() - started) / 1000) });
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }
      return json({ error: { message: "not found" } }, 404);
    }

    const signal = /^\/v1\/(traces|metrics|logs)$/.exec(url.pathname)?.[1];
    if (signal !== undefined && request.method === "POST") {
      const text = await request.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      await log.append({
        at: new Date().toISOString(),
        kind: "otlp",
        contentType: request.headers.get("content-type"),
        bytes: text.length,
        userAgent: request.headers.get("user-agent"),
        ...summarize(signal, body),
      });
      return json({});
    }

    return json({ error: "not found" }, 404);
  },
};
