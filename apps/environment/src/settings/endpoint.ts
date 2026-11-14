// @effect-diagnostics globalDate:off globalTimers:off
// The Owner-client endpoint (ADR-0034, plan D11, D12's `browser`), M5a (SPI-1200): the Settings server's second door,
// for the owner's own MCP clients (Claude Code, pi, Cursor, Codex, OpenCode) signed in through the endpoint's Access
// application with managed OAuth (plan D13; where it lives is `ownerDoor.ts`). `EnvironmentDO.settingsMcp` calls it
// with the caller the Worker already verified; it never boots t3.
//
// Hand-written JSON-RPC, stateless (the MCP SDK stays in the MCP Worker):
//
// - Versions 2026-07-28 (`server/discover`, capabilities and client info in each request's `_meta`, `resultType` on every
//   result, questions as `input_required` with a signed `requestState`), 2025-11-25 and 2025-06-18 (capabilities from
//   `initialize`, carried in a signed `Mcp-Session-Id`), and 2025-03-26 and 2024-11-05 (tools, never a question). The
//   version only decides how a question is delivered.
// - Guards before the body is parsed (plan D11): POST only, JSON only, no `Origin` and no `Sec-Fetch-Site` (no client
//   sends them, M0; a browser does), at most 256 KiB, and `elicitation_mode` one of three exact values. No CORS header
//   is ever sent; every answer is `no-store`. Any other query parameter is ignored (OpenCode adds `codemode=false`).
// - An asked change is an Open change (openChanges.ts) answered on the Change page. In `browser` the client is sent
//   there: a URL elicitation (2026 `input_required`, or a 2025-11-25 `elicitation/create` on the call's stream) when it
//   declared one, else the link in the result (`W`). The call then holds up to 45 s for the page's answer.
// - `native` and `model` (plan D12) are M5b (SPI-1201): until then they are accepted (so a client configured for them
//   connects) and answered as `browser`, the way every fallback of D12 moves, and the result says so.
import type { McpCallAnswer } from "../mcp/host.ts";
import type { OwnerCaller } from "./caller.ts";
import { canonicalJson, isChangeId, isOpen } from "./changes.ts";
import { type ChangeOutcome, outcomeOf, waitForChange } from "./openChanges.ts";
import {
  changeUrlOf,
  type OwnerCallAnswer,
  ownerListed,
  ownerMessage,
  ownerOutcome,
  ownerWaiting,
  settingsOwnerCall,
  type SettingsServerDeps,
  withdrawOwnerChange,
} from "./server.ts";
import { signToken, type TokenRefusal, verifyToken } from "./tokens.ts";
import { SETTINGS_OWNER_INSTRUCTIONS, SETTINGS_TOOLS, settingsToolOf } from "./tools.ts";

/** The 2026 version: per-request metadata, questions in results (MRTR). */
export const MODERN_VERSION = "2026-07-28";
/** The `initialize` versions, newest first. */
export const LEGACY_VERSIONS: ReadonlyArray<string> = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SUPPORTED_VERSIONS: ReadonlyArray<string> = [MODERN_VERSION, ...LEGACY_VERSIONS];
/** The largest body read (plan D11). */
export const BODY_MAX = 256 * 1024;
/** How long a `browser` call holds for the page's answer (plan D12: client timeouts are 60 s or unknown). */
export const HOLD_MS = 45_000;
/** A held stream's heartbeat: a progress notification when the call carried a token, else an SSE comment. */
export const BEAT_MS = 15_000;
/** How long a 2025 session token is honoured: the managed-OAuth session's own length (plan D13). */
export const SESSION_TTL_MS = 168 * 60 * 60_000;
export const ELICITATION_MODES = ["browser", "native", "model"] as const;
export type ElicitationMode = (typeof ELICITATION_MODES)[number];
export const SERVER_INFO = { name: "t3flare-settings", title: "t3flare Settings", version: "1" } as const;

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";
const NO_STORE = { "cache-control": "no-store" } as const;

/** Who the Worker admitted (plan D13): the owner's Access identity, or the stage's service token with the admin token. */
export type EndpointCaller = { readonly kind: "owner"; readonly subject: string } | { readonly kind: "service-token" };

export interface EndpointDeps {
  readonly server: SettingsServerDeps;
  /** The DO's token key (`settingsStateKey`). */
  readonly stateKey: () => Uint8Array<ArrayBuffer>;
  /** Real time for tokens' expiry; the server's clock by default. */
  readonly now?: () => number;
  readonly holdMs?: number;
  readonly beatMs?: number;
  /** Counts a held stream as open work until the returned function is called (the idle check, plan D17). */
  readonly work?: () => () => void;
  /** Keeps a held stream's writer running after the response is returned. */
  readonly background?: (work: Promise<unknown>) => void;
}

/** The elicitation kinds a client declared (plan D11: `{}` is form only). */
interface Declared {
  readonly form: boolean;
  readonly url: boolean;
}

/** What one request says about its client, by its version (plan D11's statelessness). */
interface Context {
  readonly modern: boolean;
  readonly version: string;
  readonly elicitation: Declared;
  readonly client?: { readonly name: string; readonly source: string };
}

type Json = Readonly<Record<string, unknown>>;

const objectOf = (value: unknown): Json | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined);

const json = (body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, "content-type": "application/json", ...headers } });

const plain = (status: number, text: string, headers: Readonly<Record<string, string>> = {}) =>
  new Response(`${text}\n`, { status, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8", ...headers } });

const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });

/** A client's own label (plan D11): display only, never trusted; cut to 60 characters with no control or format character. */
const labelOf = (text: string): string =>
  // oxlint-disable-next-line no-control-regex -- the point is to drop them
  text.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "").slice(0, 60);

const clientOf = (info: unknown, source: string): Context["client"] => {
  const fields = objectOf(info);
  if (fields === undefined || typeof fields.name !== "string" || fields.name === "") return undefined;
  const name = labelOf(`${fields.name}${typeof fields.version === "string" ? ` ${fields.version}` : ""}`);
  return name === "" ? undefined : { name, source };
};

const declaredOf = (capabilities: unknown): Declared => {
  const elicitation = objectOf(objectOf(capabilities)?.elicitation);
  if (elicitation === undefined) return { form: false, url: false };
  if (Object.keys(elicitation).length === 0) return { form: true, url: false };
  return { form: elicitation.form !== undefined, url: elicitation.url !== undefined };
};

const NONE: Declared = { form: false, url: false };

/** The request's Elicitation mode (plan D12), or undefined when it is unknown, repeated or mis-cased. Absent is `browser`. */
export const elicitationModeOf = (url: URL): ElicitationMode | undefined => {
  const named = [...url.searchParams].filter(([key]) => key.toLowerCase() === "elicitation_mode");
  if (named.length === 0) return "browser";
  if (named.length > 1) return undefined;
  const [key, value] = named[0]!;
  return key === "elicitation_mode" && (ELICITATION_MODES as ReadonlyArray<string>).includes(value) ? (value as ElicitationMode) : undefined;
};

/** The body, or undefined past `BODY_MAX` (counted as it is read, so no length header is trusted). */
const readBody = async (request: Request): Promise<{ readonly text: string } | undefined> => {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > BODY_MAX) return undefined;
  if (request.body === null) return { text: "" };
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_MAX) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes) };
};

/** A `tools/call` result from the server's answer (plan D11: text and `structuredContent`). */
const toolResult = (answer: McpCallAnswer): Json =>
  answer.kind === "result"
    ? { content: [{ type: "text", text: answer.text }], ...(answer.structured === undefined ? {} : { structuredContent: answer.structured }), isError: answer.isError }
    : { content: [{ type: "text", text: answer.message }], structuredContent: { status: "refused" }, isError: true };

const refusedResult = (text: string): McpCallAnswer => ({ kind: "result", isError: true, text, structured: { status: "refused" } });

/** The digest a `requestState` binds: the call's tool and arguments, canonical (plan D12). */
const callDigest = async (tool: string, args: Json): Promise<string> => {
  const bytes = new TextEncoder().encode(canonicalJson({ tool, args }));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const STATE_REFUSED: Readonly<Record<TokenRefusal | "other-call" | "gone", string>> = {
  malformed: "its requestState is not one this server wrote",
  "bad-signature": "its requestState is not one this server wrote",
  "wrong-kind": "its requestState is not one this server wrote",
  "other-sub": "its requestState was issued to another identity",
  expired: "its requestState has expired",
  "other-call": "its requestState was issued for another call (the tool or arguments differ)",
  gone: "the change it names is gone",
};

/**
 * One request to the Owner-client endpoint (plan D11). `caller` is the Worker's verdict; nothing in the request names who
 * calls.
 */
export const handleSettingsMcp = async (request: Request, caller: EndpointCaller, deps: EndpointDeps): Promise<Response> => {
  const server = deps.server;
  const now = deps.now ?? server.ops.now;
  const key = caller.kind === "owner" ? caller.subject : "service-token";
  const log = (event: Record<string, unknown>) => server.log?.({ via: "mcp", door: "owner", principal: caller.kind, ...event });
  const refuse = (status: number, reason: string, response: Response) => {
    log({ t3flare: "settings-refused", reason, status });
    return response;
  };

  // ── Guards, before the body is parsed ──
  if (request.method !== "POST") return refuse(405, "method", plain(405, "The Settings server answers POST only.", { allow: "POST" }));
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return refuse(415, "content-type", plain(415, "The Settings server takes application/json."));
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) return refuse(403, "browser", plain(403, "The Settings server answers MCP clients, not browsers."));
  const url = new URL(request.url);
  const requested = elicitationModeOf(url);
  if (requested === undefined) {
    return refuse(400, "elicitation-mode", json(rpcError(null, -32602, "elicitation_mode is browser, native or model: once, in lowercase (absent means browser)."), 400));
  }
  const raw = await readBody(request);
  if (raw === undefined) return refuse(413, "too-large", plain(413, `The Settings server reads at most ${BODY_MAX} bytes.`));

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  if (Array.isArray(parsed)) return json(rpcError(null, -32600, "Batches are not supported"), 400);
  const message = objectOf(parsed);
  if (message === undefined || message.jsonrpc !== "2.0") return json(rpcError(null, -32600, "Invalid request"), 400);
  const id = message.id;
  const method = message.method;
  const tokenKey = deps.stateKey();

  // A client's JSON-RPC response: its answer to a 2025 page elicitation (plan D12).
  if (method === undefined) {
    if (id === undefined || !("result" in message || "error" in message)) return json(rpcError(null, -32600, "Invalid request"), 400);
    const verdict = await verifyToken(tokenKey, id, { kind: "elicit", sub: key, now: now() });
    if (!verdict.ok) return refuse(400, `elicitation-id-${verdict.reason}`, json(rpcError(null, -32600, "This server asked no such question of this identity."), 400));
    const change = verdict.payload.change;
    const action = objectOf(message.result)?.action;
    // In `browser`, `accept` means only "opened it"; `decline` and `cancel` withdraw the change if it is still open.
    if (typeof change === "string" && isChangeId(change) && (action === "decline" || action === "cancel")) {
      const record = server.changes.get(change);
      if (record !== undefined && record.caller.key === key && record.mode === "browser") withdrawOwnerChange(server, change);
    }
    return new Response(null, { status: 202, headers: NO_STORE });
  }
  if (typeof method !== "string") return json(rpcError(null, -32600, "Invalid request"), 400);
  // A notification (`notifications/initialized`, `notifications/cancelled`): nothing to answer.
  if (id === undefined) return new Response(null, { status: 202, headers: NO_STORE });
  if (typeof id !== "string" && typeof id !== "number") return json(rpcError(null, -32600, "Invalid request id"), 400);
  if (message.params !== undefined && objectOf(message.params) === undefined) return json(rpcError(id, -32602, "params is an object"), 400);
  const params: Json = objectOf(message.params) ?? {};
  const meta = objectOf(params._meta);
  const userAgent = request.headers.get("user-agent");
  const fromAgent = userAgent === null || labelOf(userAgent) === "" ? undefined : { name: labelOf(userAgent), source: "User-Agent" };

  // ── The request's version and what its client declared ──
  let context: Context;
  const metaVersion = meta?.[META_VERSION];
  if (method !== "initialize" && metaVersion !== undefined) {
    if (metaVersion !== MODERN_VERSION) {
      return json(rpcError(id, -32022, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested: metaVersion }), 400);
    }
    const header = request.headers.get("mcp-protocol-version");
    if (header !== null && header !== metaVersion) return json(rpcError(id, -32020, "MCP-Protocol-Version does not match the request's protocol version"), 400);
    context = { modern: true, version: MODERN_VERSION, elicitation: declaredOf(meta?.[META_CAPABILITIES]), ...withClient(clientOf(meta?.[META_CLIENT], "clientInfo in _meta") ?? fromAgent) };
  } else {
    const session = await verifyToken(tokenKey, request.headers.get("mcp-session-id"), { kind: "session", sub: key, now: now() });
    const header = request.headers.get("mcp-protocol-version");
    if (session.ok) {
      const kept = session.payload;
      const version = typeof kept.protocolVersion === "string" && LEGACY_VERSIONS.includes(kept.protocolVersion) ? kept.protocolVersion : "2025-03-26";
      const elicitation = objectOf(kept.elicitation);
      const client = objectOf(kept.client);
      context = {
        modern: false,
        version,
        elicitation: { form: elicitation?.form === true, url: elicitation?.url === true },
        ...withClient((client === undefined ? undefined : clientOf(client, "clientInfo at initialize")) ?? fromAgent),
      };
    } else {
      // A missing, invalid or other identity's session reads as no elicitation declared (plan D11).
      context = { modern: false, version: header !== null && LEGACY_VERSIONS.includes(header) ? header : "2025-03-26", elicitation: NONE, ...withClient(fromAgent) };
    }
  }

  const reply = (result: Json, headers: Readonly<Record<string, string>> = {}) =>
    json({ jsonrpc: "2.0", id, result: context.modern ? { resultType: "complete", ...result, _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } } : result }, 200, headers);

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const version = typeof asked === "string" && LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0]!;
      // 2025-06-18 has form elicitation only; 2025-03-26 and older have none.
      const declared = declaredOf(params.capabilities);
      const elicitation = version === "2025-11-25" ? declared : version === "2025-06-18" ? { form: declared.form, url: false } : NONE;
      const info = objectOf(params.clientInfo);
      const at = now();
      const session = await signToken(tokenKey, {
        kind: "session",
        sub: key,
        exp: at + SESSION_TTL_MS,
        iat: at,
        protocolVersion: version,
        elicitation,
        ...(info === undefined || typeof info.name !== "string" ? {} : { client: { name: labelOf(info.name), ...(typeof info.version === "string" ? { version: labelOf(info.version) } : {}) } }),
      });
      return json(
        { jsonrpc: "2.0", id, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: SETTINGS_OWNER_INSTRUCTIONS } },
        200,
        { "mcp-session-id": session },
      );
    }
    case "server/discover":
      return reply({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: SETTINGS_OWNER_INSTRUCTIONS, ttlMs: 0, cacheScope: "private" });
    case "ping":
      return reply({});
    case "tools/list": {
      const listed = ownerListed(server);
      const tools = SETTINGS_TOOLS.filter(listed).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: tool.class === "read" } }));
      return reply(context.modern ? { tools, ttlMs: 0, cacheScope: "private" } : { tools });
    }
    case "tools/call":
      break;
    default:
      // 2026: an unknown method is 404 with -32601 (Streamable HTTP); earlier versions answer the error with 200.
      return json(rpcError(id, -32601, `Method not found: ${method}`), context.modern ? 404 : 200);
  }

  // ── tools/call ──
  const name = params.name;
  if (typeof name !== "string" || settingsToolOf(name) === undefined) return json(rpcError(id, -32602, `Unknown tool: ${typeof name === "string" ? name.slice(0, 100) : "(none)"}`));
  const args = params.arguments === undefined ? {} : objectOf(params.arguments);
  if (args === undefined) return json(rpcError(id, -32602, "arguments is an object"));
  const owner: OwnerCaller = { door: "owner", kind: caller.kind, key, ...(context.client === undefined ? {} : { client: context.client }) };
  // `native` and `model` are M5b's (SPI-1201): until then they are answered as `browser`, toward which D12 always falls back.
  const note = requested === "browser" ? undefined : `This Environment answers elicitation_mode=${requested} as browser for now.`;
  const progressToken = meta?.progressToken;

  /** Holds up to `ms` for change `id`'s answer (the page's); its outcome, or undefined when still open. */
  const hold = async (change: string, ms: number, signal?: AbortSignal): Promise<ChangeOutcome | undefined> => {
    const waiter = waitForChange(change);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const current = server.changes.get(change);
      if (current === undefined || !isOpen(current)) return current === undefined ? undefined : outcomeOf(current);
      const ended = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        if (signal !== undefined) {
          onAbort = () => resolve(undefined);
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      return await Promise.race([waiter.closed, ended]);
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      waiter.cancel();
    }
  };

  /** A call whose change is open: the page elicitation the client declared, or the link in the result. */
  const deliver = async (open: Extract<OwnerCallAnswer, { kind: "open" }>): Promise<Response> => {
    const { record, url: page, message: text } = open;
    if (context.modern) {
      if (!context.elicitation.url || page === undefined) return reply(toolResult(ownerWaiting(record, page, note)));
      const requestState = await signToken(tokenKey, { kind: "state", sub: key, exp: record.expiresAt ?? now(), change: record.id, digest: await callDigest(name, args) });
      return reply({ resultType: "input_required", inputRequests: { change: { method: "elicitation/create", params: { mode: "url", message: text, url: page } } }, requestState });
    }
    if (context.version !== "2025-11-25" || !context.elicitation.url || page === undefined) return reply(toolResult(ownerWaiting(record, page, note)));
    // 2025-11-25 with URL elicitation: the question and then the call's result, on the call's own stream.
    const elicitId = await signToken(tokenKey, { kind: "elicit", sub: key, exp: record.expiresAt ?? now(), change: record.id });
    const release = deps.work?.() ?? (() => undefined);
    const encoder = new TextEncoder();
    const stop = new AbortController();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (each) => {
        controller = each;
      },
      // A cut stream: in `browser` the change stays open for the page (plan D12); the call just ends.
      cancel: () => {
        closed = true;
        stop.abort();
      },
    });
    const send = (data: unknown) => {
      if (!closed) controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(data)}\n\n`));
    };
    const run = (async () => {
      try {
        send({ jsonrpc: "2.0", id: elicitId, method: "elicitation/create", params: { mode: "url", message: text, url: page, elicitationId: record.id } });
        const total = deps.holdMs ?? HOLD_MS;
        const beat = deps.beatMs ?? BEAT_MS;
        let waited = 0;
        let outcome: ChangeOutcome | undefined;
        let tick = 0;
        while (!closed && waited < total) {
          const slice = Math.min(beat, total - waited);
          outcome = await hold(record.id, slice, stop.signal);
          waited += slice;
          if (outcome !== undefined || closed || waited >= total) break;
          tick += 1;
          if (typeof progressToken === "string" || typeof progressToken === "number") send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: tick, message: "Waiting for the owner on the Change page" } });
          else if (!closed) controller.enqueue(encoder.encode(": waiting for the owner\n\n"));
        }
        send({ jsonrpc: "2.0", id, result: toolResult(outcome === undefined ? ownerWaiting(record, page, note) : ownerOutcome(outcome, record)) });
        if (!closed) {
          closed = true;
          controller.close();
        }
      } catch (error) {
        log({ t3flare: "settings-stream-failed", change: record.id, error: String(error).slice(0, 200) });
        if (!closed) {
          closed = true;
          controller.close();
        }
      } finally {
        release();
      }
    })();
    deps.background?.(run);
    return new Response(stream, { status: 200, headers: { ...NO_STORE, "content-type": "text/event-stream", "x-accel-buffering": "no" } });
  };

  // A 2026 retry of a call that asked (plan D12): its state is checked before anything it names is read.
  if (context.modern && params.requestState !== undefined) {
    const verdict = await verifyToken(tokenKey, params.requestState, { kind: "state", sub: key, now: now() });
    const stateProblem = !verdict.ok ? verdict.reason : verdict.payload.digest !== (await callDigest(name, args)) ? ("other-call" as const) : undefined;
    const change = verdict.ok ? verdict.payload.change : undefined;
    const record = stateProblem === undefined && typeof change === "string" && isChangeId(change) ? server.changes.get(change) : undefined;
    const problem = stateProblem ?? (record === undefined || record.caller.key !== key ? ("gone" as const) : undefined);
    if (problem !== undefined || record === undefined) {
      log({ t3flare: "settings-refused", reason: `request-state-${problem ?? "gone"}`, tool: name });
      return reply(toolResult(refusedResult(`Not changed: ${STATE_REFUSED[problem ?? "gone"]}. Call ${name} again without requestState to ask afresh.`)));
    }
    const action = objectOf(objectOf(params.inputResponses)?.change)?.action;
    if (action === "decline" || action === "cancel") {
      const outcome = withdrawOwnerChange(server, record.id) ?? outcomeOf(record);
      return reply(toolResult(ownerOutcome(outcome, record)));
    }
    if (!isOpen(record)) return reply(toolResult(ownerOutcome(outcomeOf(record), record)));
    const page = changeUrlOf(server, record.id);
    // No answer to the question: ask it again, on the same Open change (MRTR: the server may ask again).
    if (action !== "accept") return deliver({ kind: "open", record, url: page, message: record.shown === undefined ? "A change waits for you on the Change page." : ownerMessage(record.shown, owner) });
    // `accept` means only "opened it": hold for the page's answer.
    const outcome = await hold(record.id, deps.holdMs ?? HOLD_MS);
    return reply(toolResult(outcome === undefined ? ownerWaiting(record, page, note) : ownerOutcome(outcome, record)));
  }

  const answered = await settingsOwnerCall(server, { tool: name, args, caller: owner, mode: "browser" });
  if (answered.kind === "result") return reply(toolResult(answered.answer));
  return deliver(answered);
};

const withClient = (client: Context["client"]): { readonly client?: NonNullable<Context["client"]> } => (client === undefined ? {} : { client });
