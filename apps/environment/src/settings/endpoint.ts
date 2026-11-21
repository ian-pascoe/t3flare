// @effect-diagnostics globalTimers:off
// The Owner-client endpoint (ADR-0035, plan D11, D12), M5a and M5b (SPI-1200, SPI-1201): the Settings server's second
// door, for the owner's own MCP clients (Claude Code, pi, Cursor, Codex, OpenCode) signed in through the endpoint's
// Access application with managed OAuth (ADR-0036; where it lives is `endpointLayout.ts`). `EnvironmentDO.settingsMcp`
// calls it with the caller the Worker already verified; it never boots t3.
//
// Hand-written JSON-RPC, stateless but for the one row it records per client (clients.ts: the client's mode, set on the
// Settings page alone; the MCP SDK stays in the MCP Worker):
//
// - Versions 2026-07-28 (`server/discover`, capabilities and client info in each request's `_meta`, `resultType` on every
//   result, questions as `input_required` with a signed `requestState`), 2025-11-25 and 2025-06-18 (capabilities from
//   `initialize`, carried in a signed `Mcp-Session-Id`), and 2025-03-26 and 2024-11-05 (tools, never a question). The
//   version only decides how a question is delivered.
// - Guards before the body is parsed (plan D11): POST only, JSON only, no `Origin` and no `Sec-Fetch-Site` (no client
//   sends them, M0; a browser does), at most 256 KiB, and `elicitation_mode`, when given, one of three exact values. No
//   CORS header is ever sent; every answer is `no-store`. Any other query parameter is ignored (OpenCode adds
//   `codemode=false`).
// - The request's Elicitation mode (plan D12; ADR-0035's 2026-11-15 refinement): an explicit `?elicitation_mode=`, else
//   the mode the owner set on the Settings page for this caller's key and the client's `clientInfo.name` (clients.ts),
//   else `browser`; a request with no client name is `browser`. Every request with a client name records it as seen.
//   Nothing here, and no tool, changes a client's mode: only the panel does.
// - An asked change is an Open change (openChanges.ts) in the request's Elicitation mode (plan D12), after its fallbacks
//   toward `browser`: `native` with no form elicitation declared, and any change that needs the page (D6), are `browser`.
//   The Change page answers every mode; the first answer wins.
//   - `browser`: the client is sent to the page: a URL elicitation (2026 `input_required`, or a 2025-11-25
//     `elicitation/create` on the call's stream) when it declared one, else the link in the result (`W`). The call then
//     holds up to 45 s for the page's answer.
//   - `native` (M5b, SPI-1201): a form with no fields in the client, whose `accept` applies the change. 2026: an
//     `input_required` form answered by the retry, no hold. 2025-06-18 and 2025-11-25: `elicitation/create` on the call's
//     stream, held until the response POST, the stream's end (which withdraws the change) or the change's expiry.
//   - `model` (M5b): the result is Executor's Pause at once (every version), and `resume`, listed in this mode alone,
//     answers it. A change that needs the page gets the link, never a Pause.
import { withoutHidden } from "@t3flare/harness-registry";
import { sha256Hex } from "@t3flare/skills";

import type { AccessCaller } from "../access.ts";
import { canonicalJson } from "../mcp/canonical.ts";
import type { McpCallAnswer } from "../mcp/host.ts";
import { OFF_MESSAGE, type OwnerCaller } from "./caller.ts";
import { type ChangeRecord, isChangeId, isOpen, OWNER_MODES, type OwnerMode } from "./changes.ts";
import { CLIENT_NAME_MAX, clientNameOf, type OwnerClients } from "./clients.ts";
import { type ChangeOutcome, closeOrSettle, outcomeOf, waitForChange } from "./openChanges.ts";
import {
  answerDepsOf,
  answerOwnerChange,
  changeUrlOf,
  EMPTY_SCHEMA,
  HIDDEN_SINCE_REFUSAL,
  hiddenTools,
  modeFor,
  ownerListed,
  ownerMessage,
  ownerOutcome,
  ownerPause,
  ownerResume,
  ownerWaiting,
  READ_ONLY_REFUSAL,
  accessSwitchOf,
  settingsOwnerCall,
  type SettingsServerDeps,
  withdrawOwnerChange,
} from "./server.ts";
import { PAGE_REASON } from "./render.ts";
import { signToken, type TokenRefusal, verifyToken } from "./tokens.ts";
import { OWNER_MODE_INSTRUCTIONS, RESUME_TOOL, SETTINGS_OWNER_INSTRUCTIONS, SETTINGS_TOOLS, settingsToolOf, toolDefinition } from "./tools.ts";

/** The 2026 version: per-request metadata, questions in results (MRTR). */
export const MODERN_VERSION = "2026-07-28";
/** The 2025 version with URL elicitation (the `browser` question on the call's stream). */
export const URL_ELICITATION_VERSION = "2025-11-25";
/** The first version with elicitation, form only and without `mode` in its params. */
export const FORM_ELICITATION_VERSION = "2025-06-18";
/** Tools with no elicitation: what a request with no session (or a forged one) reads as. */
export const NO_ELICITATION_VERSION = "2025-03-26";
/** The `initialize` versions, newest first. */
export const LEGACY_VERSIONS: ReadonlyArray<string> = [URL_ELICITATION_VERSION, FORM_ELICITATION_VERSION, NO_ELICITATION_VERSION, "2024-11-05"];
export const SUPPORTED_VERSIONS: ReadonlyArray<string> = [MODERN_VERSION, ...LEGACY_VERSIONS];
/** The largest body read (plan D11). */
export const BODY_MAX = 256 * 1024;
/** How long a `browser` call holds for the page's answer (plan D12: client timeouts are 60 s or unknown). */
export const HOLD_MS = 45_000;
/** A held stream's heartbeat: a progress notification when the call carried a token, else an SSE comment. */
export const BEAT_MS = 15_000;
/** How long a 2025 session token is honoured: the managed-OAuth session's own length (plan D13). */
export const SESSION_TTL_MS = 168 * 60 * 60_000;
export const SERVER_INFO = { name: "t3flare-settings", title: "t3flare Settings", version: "1" } as const;

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
/** A 2026 listing's or discovery's cache hints: never cached, never shared (the tools follow the access switch). */
const NO_CACHE = { ttlMs: 0, cacheScope: "private" } as const;
const NO_STORE = { "cache-control": "no-store" } as const;

export interface EndpointDeps {
  readonly server: SettingsServerDeps;
  /** The DO's token key (`settingsStateKey`). */
  readonly stateKey: () => Uint8Array<ArrayBuffer>;
  /** Real time for tokens' expiry; the server's clock by default. */
  readonly now?: () => number;
  readonly holdMs?: number;
  readonly beatMs?: number;
  /** At most how long a 2025 `native` stream holds for the form's answer; the change's expiry by default (tests shorten it). */
  readonly formWaitMs?: number;
  /** Counts a held stream as open work until the returned function is called (the idle check, plan D17). */
  readonly work?: () => () => void;
  /** Keeps a held stream's writer running after the response is returned. */
  readonly background?: (work: Promise<unknown>) => void;
  /** The held streams live in this isolate; the isolate's own by default (tests give each Environment its own). */
  readonly holds?: StreamHolds;
  /**
   * The Owner clients' kept modes (clients.ts): `seen` alone, so this door can read a mode and record a client but never
   * set one (only the panel does). Without it every request with no `?elicitation_mode=` is `browser`.
   */
  readonly clients?: Pick<OwnerClients, "seen">;
}

/** Live held streams (a 2025 call's question on its own stream) per change and per caller, in this isolate. */
export interface StreamHolds {
  readonly byChange: Map<string, number>;
  readonly byCaller: Map<string, number>;
}

export const streamHolds = (): StreamHolds => ({ byChange: new Map(), byCaller: new Map() });

/**
 * This isolate's held streams (SPI-1201 review, C2 and C3). In memory on purpose: a stream is a live response, so an
 * Environment reset ends every one, and a 2025 `native` answer that arrives with none live must apply nothing (D12).
 */
const ISOLATE_HOLDS = streamHolds();

/** At most this many live held streams on one Open change (a client's retry may open a second; SPI-1201 review). */
export const HOLDS_PER_CHANGE = 2;
/**
 * At most this many live held streams per caller (an Access `sub`, or the service token), across its changes: a
 * backstop, since `OPEN_PER_OWNER` changes of `HOLDS_PER_CHANGE` streams stay under it today.
 */
export const HOLDS_PER_CALLER = 8;

const countUp = (counts: Map<string, number>, key: string): void => void counts.set(key, (counts.get(key) ?? 0) + 1);
/** Counts one holder of `key` down; answers how many remain. */
const countDown = (counts: Map<string, number>, key: string): number => {
  const left = (counts.get(key) ?? 1) - 1;
  if (left <= 0) counts.delete(key);
  else counts.set(key, left);
  return Math.max(0, left);
};

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
  /** The client's own `clientInfo.name` (no version, never the User-Agent): what its kept mode is keyed by. */
  readonly clientName?: string;
}

type Json = Readonly<Record<string, unknown>>;

const objectOf = (value: unknown): Json | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined);

const json = (body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, "content-type": "application/json", ...headers } });

const plain = (status: number, text: string, headers: Readonly<Record<string, string>> = {}) =>
  new Response(`${text}\n`, { status, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8", ...headers } });

const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });

/** A client's own label (plan D11): display only, never trusted; no hidden character, cut to 60 characters. */
const labelOf = (text: string): string => withoutHidden(text).slice(0, CLIENT_NAME_MAX);

const clientOf = (info: unknown, source: string): Context["client"] => {
  const fields = objectOf(info);
  if (fields === undefined || typeof fields.name !== "string" || fields.name === "") return undefined;
  const name = labelOf(`${fields.name}${typeof fields.version === "string" ? ` ${fields.version}` : ""}`);
  return name === "" ? undefined : { name, source };
};

const withClient = (client: Context["client"]): { readonly client?: NonNullable<Context["client"]> } => (client === undefined ? {} : { client });

const withName = (name: unknown): { readonly clientName?: string } => {
  const clientName = clientNameOf(name);
  return clientName === undefined ? {} : { clientName };
};

const NONE: Declared = { form: false, url: false };

const declaredOf = (capabilities: unknown): Declared => {
  const elicitation = objectOf(objectOf(capabilities)?.elicitation);
  if (elicitation === undefined) return NONE;
  if (Object.keys(elicitation).length === 0) return { form: true, url: false };
  return { form: elicitation.form !== undefined, url: elicitation.url !== undefined };
};

/**
 * The request's explicit Elicitation mode (plan D12): `null` when the URL names none (the client's kept mode decides),
 * undefined when it is unknown, repeated or mis-cased (400).
 */
export const elicitationModeOf = (url: URL): OwnerMode | null | undefined => {
  const named = [...url.searchParams].filter(([key]) => key.toLowerCase() === "elicitation_mode");
  if (named.length === 0) return null;
  if (named.length > 1) return undefined;
  const [key, value] = named[0]!;
  return key === "elicitation_mode" && (OWNER_MODES as ReadonlyArray<string>).includes(value) ? (value as OwnerMode) : undefined;
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
const callDigest = (tool: string, args: Json): Promise<string> => sha256Hex(canonicalJson({ tool, args }));

const STATE_REFUSED: Readonly<Record<TokenRefusal | "other-call" | "gone", string>> = {
  malformed: "its requestState is not one this server wrote",
  "bad-signature": "its requestState is not one this server wrote",
  "wrong-kind": "its requestState is not one this server wrote",
  "other-sub": "its requestState was issued to another identity",
  expired: "its requestState has expired",
  "other-call": "its requestState was issued for another call (the tool or arguments differ)",
  gone: "the change it names is gone",
};

/** The 2026 spec's sentinel around a Base64 (UTF-8) header value: `=?base64?…?=`. */
const BASE64_HEADER_OPEN = "=?base64?";
const BASE64_HEADER_CLOSE = "?=";

/** A 2026 `Mcp-Name` value: plain, or in the spec's Base64 sentinel. Undefined when malformed. */
const headerValue = (raw: string): string | undefined => {
  if (!raw.startsWith(BASE64_HEADER_OPEN) || !raw.endsWith(BASE64_HEADER_CLOSE)) return raw;
  try {
    const encoded = raw.slice(BASE64_HEADER_OPEN.length, -BASE64_HEADER_CLOSE.length);
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
  } catch {
    return undefined;
  }
};

/** Which of a 2026 request's standard headers is missing or differs from its body, or undefined when they agree. */
const headerMismatch = (headers: Headers, version: unknown, method: string, name: unknown): string | undefined => {
  const versionHeader = headers.get("mcp-protocol-version");
  if (versionHeader === null) return "MCP-Protocol-Version is missing";
  if (versionHeader !== version) return "MCP-Protocol-Version does not match the request's protocol version";
  const methodHeader = headers.get("mcp-method");
  if (methodHeader === null) return "Mcp-Method is missing";
  if (methodHeader !== method) return "Mcp-Method does not match the request's method";
  if (name === undefined) return undefined;
  const nameHeader = headers.get("mcp-name");
  if (nameHeader === null) return "Mcp-Name is missing";
  return headerValue(nameHeader) === name ? undefined : "Mcp-Name does not match the request's name";
};

/**
 * One request to the Owner-client endpoint (plan D11). `caller` is the Worker's verdict; nothing in the request names who
 * calls.
 */
export const handleSettingsMcp = async (request: Request, caller: AccessCaller, deps: EndpointDeps): Promise<Response> => {
  const server = deps.server;
  const holds = deps.holds ?? ISOLATE_HOLDS;
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
  const explicit = elicitationModeOf(url);
  if (explicit === undefined) {
    return refuse(
      400,
      "elicitation-mode",
      json(rpcError(null, -32602, "elicitation_mode is browser, native or model: once, in lowercase (absent means the client's mode on the Settings page, browser until the owner sets it)."), 400),
    );
  }
  /**
   * The request's Elicitation mode (plan D12): the query's, else the panel's for this key and client name, else
   * `browser`. Records the client as seen either way.
   */
  const modeOf = (clientInfoName: unknown): OwnerMode => {
    const clientName = clientNameOf(clientInfoName);
    const kept = clientName === undefined ? undefined : deps.clients?.seen(key, clientName);
    return explicit ?? kept ?? "browser";
  };
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
    const record = typeof change === "string" && isChangeId(change) ? server.changes.get(change) : undefined;
    const action = objectOf(message.result)?.action;
    if (record !== undefined && record.caller.door === "owner" && record.caller.key === key && record.mode === "native") {
      // `native` (plan D12): the form's answer. `accept` applies the change (by `client`), `decline` declines it, `cancel`
      // withdraws it; the held call then writes its result. A response in another mode than the change's is refused:
      // the mode is this request's (its session's client name), so a client the owner moved off `native` since cannot
      // answer, and the change waits on its Change page.
      const session = await verifyToken(tokenKey, request.headers.get("mcp-session-id"), { kind: "session", sub: key, now: now() });
      if (modeOf(session.ok ? objectOf(session.payload.client)?.name : undefined) !== "native") {
        const why = session.ok
          ? "this client is in another now (its mode on the Settings page, or ?elicitation_mode=)"
          : "this request carries no valid Mcp-Session-Id, so its client is unknown here and the mode is browser (send the answer on the session that was asked, or add ?elicitation_mode=native)";
        return refuse(400, "other-mode", json(rpcError(null, -32600, `This question was asked in the native Elicitation mode, and ${why}. Answer it on its Change page.`), 400));
      }
      // No stream of this isolate holds the question (the Environment reset since, or it ended unanswered): nobody waits
      // for the result, so the answer applies nothing and the change is withdrawn by `stop` (plan D12; SPI-1201 review).
      if ((holds.byChange.get(record.id) ?? 0) === 0) {
        await withdrawOwnerChange(server, record.id, "stop");
        log({ t3flare: "settings-refused", reason: "no-live-stream", change: record.id });
        return new Response(null, { status: 202, headers: NO_STORE });
      }
      if (action === "accept" || action === "decline") await answerOwnerChange(server, record, { kind: caller.kind, key }, "client", action);
      // `cancel`, or a JSON-RPC error in place of a result (the client could not ask): withdrawn, so the held call ends.
      else if (action === "cancel" || "error" in message) await withdrawOwnerChange(server, record.id);
      return new Response(null, { status: 202, headers: NO_STORE });
    }
    // In `browser`, `accept` means only "opened it"; `decline` and `cancel` withdraw the change if it is still open.
    if (record !== undefined && record.caller.door === "owner" && record.caller.key === key && record.mode === "browser" && (action === "decline" || action === "cancel")) await withdrawOwnerChange(server, record.id);
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
    // 2026 Streamable HTTP's standard headers (spec, "Server Validation"): `MCP-Protocol-Version` and `Mcp-Method` on
    // every request and `Mcp-Name` on `tools/call`, each present and equal to the body's value, else `-32020` with 400.
    const mismatch = headerMismatch(request.headers, metaVersion, method, method === "tools/call" ? params.name : undefined);
    if (mismatch !== undefined) return json(rpcError(id, -32020, `Header mismatch: ${mismatch}`), 400);
    context = {
      modern: true,
      version: MODERN_VERSION,
      elicitation: declaredOf(meta?.[META_CAPABILITIES]),
      ...withClient(clientOf(meta?.[META_CLIENT], "clientInfo in _meta") ?? fromAgent),
      ...withName(objectOf(meta?.[META_CLIENT])?.name),
    };
  } else {
    const session = await verifyToken(tokenKey, request.headers.get("mcp-session-id"), { kind: "session", sub: key, now: now() });
    const header = request.headers.get("mcp-protocol-version");
    // A 2026 header on a request whose body names no 2026 version in `_meta`: the header and the body disagree (2026
    // "Server Validation", -32020), which is not an unknown version (SPI-1201 review).
    if (method !== "initialize" && header === MODERN_VERSION) {
      return json(rpcError(id, -32020, "Header mismatch: MCP-Protocol-Version is 2026-07-28 but the request's _meta names no protocol version"), 400);
    }
    // 2025-06-18 and 2025-11-25 (Transports, "Protocol Version Header"): an invalid or unsupported version is 400; a
    // missing header is 2025-03-26. `initialize` negotiates in its body, so its header is not judged.
    if (method !== "initialize" && header !== null && !LEGACY_VERSIONS.includes(header)) {
      return json(rpcError(id, -32600, "Unsupported MCP-Protocol-Version", { supported: SUPPORTED_VERSIONS, requested: header.slice(0, 40) }), 400);
    }
    if (session.ok) {
      const kept = session.payload;
      const version = typeof kept.protocolVersion === "string" && LEGACY_VERSIONS.includes(kept.protocolVersion) ? kept.protocolVersion : NO_ELICITATION_VERSION;
      const elicitation = objectOf(kept.elicitation);
      const client = objectOf(kept.client);
      context = {
        modern: false,
        version,
        elicitation: { form: elicitation?.form === true, url: elicitation?.url === true },
        ...withClient((client === undefined ? undefined : clientOf(client, "clientInfo at initialize")) ?? fromAgent),
        ...withName(client?.name),
      };
    } else {
      // A missing, invalid or other identity's session reads as no elicitation declared (plan D11).
      context = { modern: false, version: header !== null && LEGACY_VERSIONS.includes(header) ? header : NO_ELICITATION_VERSION, elicitation: NONE, ...withClient(fromAgent) };
    }
  }

  // `initialize` carries the client's name in its body; every other request in `_meta` (2026) or its session (2025).
  const requested = modeOf(method === "initialize" ? objectOf(params.clientInfo)?.name : context.clientName);
  const instructions = `${SETTINGS_OWNER_INSTRUCTIONS}${OWNER_MODE_INSTRUCTIONS[requested]}`;
  const reply = (result: Json, headers: Readonly<Record<string, string>> = {}) =>
    json({ jsonrpc: "2.0", id, result: context.modern ? { resultType: "complete", ...result, _meta: { [META_SERVER]: SERVER_INFO } } : result }, 200, headers);

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const version = typeof asked === "string" && LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0]!;
      // 2025-06-18 has form elicitation only; 2025-03-26 and older have none.
      const declared = declaredOf(params.capabilities);
      const elicitation = version === URL_ELICITATION_VERSION ? declared : version === FORM_ELICITATION_VERSION ? { form: declared.form, url: false } : NONE;
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
        { jsonrpc: "2.0", id, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions } },
        200,
        { "mcp-session-id": session },
      );
    }
    case "server/discover":
      return reply({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions, ...NO_CACHE });
    case "ping":
      return reply({});
    case "tools/list": {
      const listed = ownerListed(server);
      // `resume` in `model` alone (plan D12), and only while writes are listed: it applies changes.
      const tools = [...SETTINGS_TOOLS, ...(requested === "model" ? [RESUME_TOOL] : [])].filter(listed).map(toolDefinition);
      return reply(context.modern ? { tools, ...NO_CACHE } : { tools });
    }
    case "tools/call":
      break;
    default:
      // 2026: an unknown method is 404 with -32601 (Streamable HTTP); earlier versions answer the error with 200.
      return json(rpcError(id, -32601, `Method not found: ${method}`), context.modern ? 404 : 200);
  }

  // ── tools/call ──
  const name = params.name;
  // `resume` is a tool of `model` alone (plan D12): to any other request it is as unknown as it is unlisted.
  const isResume = name === RESUME_TOOL.name && requested === "model";
  if (typeof name !== "string" || (!isResume && settingsToolOf(name) === undefined)) return json(rpcError(id, -32602, `Unknown tool: ${typeof name === "string" ? name.slice(0, 100) : "(none)"}`));
  const args = params.arguments === undefined ? {} : objectOf(params.arguments);
  if (args === undefined) return json(rpcError(id, -32602, "arguments is an object"));
  const owner: OwnerCaller = { door: "owner", kind: caller.kind, key, ...(context.client === undefined ? {} : { client: context.client }) };
  if (isResume) return reply(toolResult(await ownerResume(server, { args, caller: owner })));
  // The mode this request opens a change in (plan D12's fallbacks): `native` with no form elicitation declared is
  // `browser` for this request; a change that needs the page is `browser` whatever was asked (the server decides that).
  const asked: OwnerMode = requested === "native" && !context.elicitation.form ? "browser" : requested;
  const progressToken = meta?.progressToken;
  /** Why a change asked in another mode waits on the page instead, said in its `W`. */
  const noteOf = (record: ChangeRecord): string | undefined =>
    record.needsPage !== undefined && requested !== "browser"
      ? `${PAGE_REASON[record.needsPage]("its Change page")} That holds in every Elicitation mode.`
      : requested === "native" && record.mode === "browser"
        ? "This client declared no form elicitation, so its native Elicitation mode falls back to the Change page."
        : undefined;
  const messageOf = (record: ChangeRecord, page: string | undefined): string =>
    record.shown === undefined ? "A change waits for you on the Change page." : ownerMessage(record.shown, owner, record.mode === "native" || record.mode === "model" ? record.mode : "browser", page);

  /** Holds up to `ms` for Open change `change`'s answer; its outcome, or undefined when still open. */
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

  /**
   * A 2025 question on the call's own stream (plan D12): `question`, then a hold of up to `totalMs` with a heartbeat each
   * beat (`waiting.progress` as progress when the call carried a token, `waiting.comment` as an SSE comment otherwise),
   * then the call's result from `finish` and the stream's end. `onCut` runs when the client cuts the stream before an
   * answer.
   */
  const heldStream = ({
    record,
    question,
    waiting,
    totalMs,
    finish,
    onCut,
  }: {
    readonly record: ChangeRecord;
    readonly question: Json;
    readonly waiting: { readonly progress: string; readonly comment: string };
    readonly totalMs: number;
    readonly finish: (outcome: ChangeOutcome | undefined) => McpCallAnswer | Promise<McpCallAnswer>;
    readonly onCut?: () => Promise<void>;
  }): Response => {
    const releaseWork = deps.work?.() ?? (() => undefined);
    countUp(holds.byChange, record.id);
    countUp(holds.byCaller, key);
    let held = true;
    /** Ends this stream's hold once; answers how many streams still hold its change. */
    const releaseHold = (): number => {
      if (!held) return holds.byChange.get(record.id) ?? 0;
      held = false;
      countDown(holds.byCaller, key);
      return countDown(holds.byChange, record.id);
    };
    const encoder = new TextEncoder();
    const stop = new AbortController();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (each) => {
        controller = each;
      },
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
        send(question);
        const beat = deps.beatMs ?? BEAT_MS;
        let waited = 0;
        let outcome: ChangeOutcome | undefined;
        let tick = 0;
        while (!closed && waited < totalMs) {
          const slice = Math.min(beat, totalMs - waited);
          outcome = await hold(record.id, slice, stop.signal);
          waited += slice;
          if (outcome !== undefined || closed || waited >= totalMs) break;
          tick += 1;
          if (typeof progressToken === "string" || typeof progressToken === "number") send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: tick, message: waiting.progress } });
          else if (!closed) controller.enqueue(encoder.encode(`: ${waiting.comment}\n\n`));
        }
        if (closed && outcome === undefined) {
          // Only the last stream holding the change withdraws it on its cut; another still shows the question (C3).
          if (releaseHold() === 0) await onCut?.();
          return;
        }
        send({ jsonrpc: "2.0", id, result: toolResult(await finish(outcome)) });
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
        releaseHold();
        releaseWork();
      }
    })();
    deps.background?.(run);
    return new Response(stream, { status: 200, headers: { ...NO_STORE, "content-type": "text/event-stream", "x-accel-buffering": "no" } });
  };

  /** Why a new held stream on `record` would pass a cap (C3), said in the `W` it gets instead; undefined when it may hold. */
  const holdsFull = (record: ChangeRecord): string | undefined =>
    (holds.byChange.get(record.id) ?? 0) >= HOLDS_PER_CHANGE
      ? `${HOLDS_PER_CHANGE} calls already wait on this change's question; answer it there or on its Change page.`
      : (holds.byCaller.get(key) ?? 0) >= HOLDS_PER_CALLER
        ? `${HOLDS_PER_CALLER} of your calls already wait on a question; answer them, or this change on its Change page.`
        : undefined;

  const stateOf = async (record: ChangeRecord) => signToken(tokenKey, { kind: "state", sub: key, exp: record.expiresAt ?? now(), change: record.id, digest: await callDigest(name, args) });

  /** `browser` (plan D12): the page elicitation the client declared, or the link in the result; in `model`, always the link. */
  const deliverBrowser = async (record: ChangeRecord, page: string | undefined, text: string): Promise<Response> => {
    const note = noteOf(record);
    if (requested === "model" || page === undefined || !context.elicitation.url) return reply(toolResult(ownerWaiting(record, page, note)));
    if (context.modern) {
      return reply({ resultType: "input_required", inputRequests: { change: { method: "elicitation/create", params: { mode: "url", message: text, url: page } } }, requestState: await stateOf(record) });
    }
    if (context.version !== URL_ELICITATION_VERSION) return reply(toolResult(ownerWaiting(record, page, note)));
    const full = holdsFull(record);
    if (full !== undefined) return reply(toolResult(ownerWaiting(record, page, full)));
    // 2025-11-25 with URL elicitation: the question and then the call's result on the call's stream; a cut stream leaves
    // the change open for the page (plan D12).
    const elicitId = await signToken(tokenKey, { kind: "elicit", sub: key, exp: record.expiresAt ?? now(), change: record.id });
    return heldStream({
      record,
      question: { jsonrpc: "2.0", id: elicitId, method: "elicitation/create", params: { mode: "url", message: text, url: page, elicitationId: record.id } },
      waiting: { progress: "Waiting for the owner on the Change page", comment: "waiting for the owner" },
      totalMs: deps.holdMs ?? HOLD_MS,
      finish: (outcome) => (outcome === undefined ? ownerWaiting(record, page, note) : ownerOutcome(outcome, record)),
    });
  };

  /**
   * `native` (plan D12): a form with no fields in the client. 2026: `input_required`, answered by the retry, no hold.
   * 2025-06-18 and 2025-11-25: `elicitation/create` on the call's stream, held until the client's response POST, the
   * stream's end (which withdraws the change: nothing is written with nobody watching) or the change's expiry.
   */
  const deliverNative = async (record: ChangeRecord, page: string | undefined, text: string): Promise<Response> => {
    const form = { message: text, requestedSchema: EMPTY_SCHEMA };
    if (context.modern) {
      return reply({ resultType: "input_required", inputRequests: { change: { method: "elicitation/create", params: { mode: "form", ...form } } }, requestState: await stateOf(record) });
    }
    // Defensive, unreachable today: a native-mode change is opened only for a request that declared form elicitation,
    // which a 2025 context has only at 2025-06-18 or 2025-11-25 (`asked` above), and a repeat reuses only a change of
    // the request's own mode. Should that ever change, the client gets the link rather than a question it cannot show.
    if (!context.elicitation.form || (context.version !== URL_ELICITATION_VERSION && context.version !== FORM_ELICITATION_VERSION)) return reply(toolResult(ownerWaiting(record, page, noteOf(record))));
    const full = holdsFull(record);
    if (full !== undefined) return reply(toolResult(ownerWaiting(record, page, full)));
    const elicitId = await signToken(tokenKey, { kind: "elicit", sub: key, exp: record.expiresAt ?? now(), change: record.id });
    const untilExpiry = Math.max(0, (record.expiresAt ?? now()) - now());
    return heldStream({
      record,
      // 2025-06-18 has no `mode`.
      question: { jsonrpc: "2.0", id: elicitId, method: "elicitation/create", params: context.version === FORM_ELICITATION_VERSION ? form : { mode: "form", ...form } },
      waiting: { progress: "Waiting for the answer in the client's form", comment: "waiting for the form's answer" },
      totalMs: Math.min(untilExpiry, deps.formWaitMs ?? untilExpiry),
      finish: async (outcome) => ownerOutcome(outcome ?? (await closeOrSettle(answerDepsOf(server), record.id, "expired")) ?? { state: "expired" }, record),
      // The client went away unanswered: the change is withdrawn (its close line says `cut`), and a response that arrives
      // later applies nothing.
      onCut: async () => void (await withdrawOwnerChange(server, record.id, "stop", true)),
    });
  };

  /** A call whose change is open, delivered in the change's mode. */
  const deliver = async (record: ChangeRecord): Promise<Response> => {
    const page = changeUrlOf(server, record.id);
    const text = messageOf(record, page);
    switch (record.mode) {
      case "model":
        return reply(toolResult(ownerPause(record, text)));
      case "native":
        return deliverNative(record, page, text);
      default:
        return deliverBrowser(record, page, text);
    }
  };

  // A 2026 retry of a call that asked (plan D12): the access switch first (plan D2: off refuses every call, read-only
  // every write, naming the panel), then whether its tool is hidden now, then its state, before anything it names is read.
  if (context.modern && params.requestState !== undefined) {
    const access = accessSwitchOf(server);
    if (access !== "on") {
      log({ t3flare: "settings-refused", reason: access, tool: name });
      return reply(toolResult(refusedResult(access === "off" ? OFF_MESSAGE : READ_ONLY_REFUSAL)));
    }
    // A tool the owner hid since the change was asked (SPI-1195 review): refused as a fresh call would be, naming the panel.
    if (hiddenTools(server)(name)) {
      log({ t3flare: "settings-refused", reason: "hidden", tool: name });
      return reply(toolResult(refusedResult(`Not changed: ${HIDDEN_SINCE_REFUSAL(name)}`)));
    }
    const verdict = await verifyToken(tokenKey, params.requestState, { kind: "state", sub: key, now: now() });
    const stateProblem = !verdict.ok ? verdict.reason : verdict.payload.digest !== (await callDigest(name, args)) ? ("other-call" as const) : undefined;
    const change = verdict.ok ? verdict.payload.change : undefined;
    const record = stateProblem === undefined && typeof change === "string" && isChangeId(change) ? server.changes.get(change) : undefined;
    const problem = stateProblem ?? (record === undefined || record.caller.door !== "owner" || record.caller.key !== key ? ("gone" as const) : undefined);
    if (problem !== undefined || record === undefined) {
      log({ t3flare: "settings-refused", reason: `request-state-${problem ?? "gone"}`, tool: name });
      return reply(toolResult(refusedResult(`Not changed: ${STATE_REFUSED[problem ?? "gone"]}. Call ${name} again without requestState to ask afresh.`)));
    }
    // A retry in another mode than the change's is refused (plan D8: coherence, not a floor).
    const mode = modeFor(asked, record.needsPage);
    if (record.mode !== mode) {
      log({ t3flare: "settings-refused", reason: "other-mode", tool: name, change: record.id });
      return reply(
        toolResult(
          refusedResult(
            `Not changed: this change was asked in the ${record.mode ?? "card"} Elicitation mode, not ${mode} (the client's mode on the Settings page, or ?elicitation_mode=, changed since). Answer it in that mode or on its Change page, or call ${name} again without requestState to ask in this one.`,
          ),
        ),
      );
    }
    const action = objectOf(objectOf(params.inputResponses)?.change)?.action;
    if (record.mode === "native" && action === "decline" && isOpen(record)) return reply(toolResult(await answerOwnerChange(server, record, owner, "client", "decline")));
    // `browser`'s decline and cancel, and `native`'s cancel: the client withdraws its question.
    if (action === "decline" || action === "cancel") return reply(toolResult(ownerOutcome((await withdrawOwnerChange(server, record.id)) ?? outcomeOf(record), record)));
    if (!isOpen(record)) return reply(toolResult(ownerOutcome(outcomeOf(record), record)));
    // No answer to the question: ask it again, on the same Open change (MRTR: the server may ask again).
    if (action !== "accept") return deliver(record);
    // `native`: the client's accept applies the change (plan D12), answered by `client`.
    if (record.mode === "native") return reply(toolResult(await answerOwnerChange(server, record, owner, "client", "accept")));
    // `browser`: accept means only "opened it": hold for the page's answer.
    const page = changeUrlOf(server, record.id);
    const outcome = await hold(record.id, deps.holdMs ?? HOLD_MS);
    return reply(toolResult(outcome === undefined ? ownerWaiting(record, page, noteOf(record)) : ownerOutcome(outcome, record)));
  }

  const answered = await settingsOwnerCall(server, { tool: name, args, caller: owner, mode: asked });
  if (answered.kind === "result") return reply(toolResult(answered.answer));
  return deliver(answered.record);
};

