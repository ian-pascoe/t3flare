// @effect-diagnostics globalJsonInEffect:off globalDate:off globalConsole:off globalFetch:off globalTimers:off nodeBuiltinImport:off extendsNativeError:off
// Step 3: a linking environment's side of a Peer link, in TypeScript, as t3's laptop does it (`PeerLinks.signIn`,
// `PeerMcpClient`): the pairing code minted by the owner's session, the three MCP OAuth steps, and an MCP session on
// `/mcp` with `T3-Mode-Limit`, 404 re-initialisation and waits in 50 s pieces. Used by `acceptance.ts --peer`, the M0
// probes and the two-server end-to-end run. Nothing secret is printed: tokens stay in memory.
import { createHash, randomBytes } from "node:crypto";

import { base } from "./client.ts";

/** t3's names on the linking side (`PeerLinks.ts`): a Peer link's OAuth client. */
export const PEER_LINK_SOFTWARE_ID = "t3code-peer-link";
export const PEER_LINK_REDIRECT_URI = "http://127.0.0.1/t3code-peer-link";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** `PeerForwarding.FORWARDED_WAIT_CHUNK_MS`: the peer sends nothing while it waits, so no wait outlives this. */
export const WAIT_CHUNK_MS = 50_000;

export type LinkAccess = "read-only" | "approval-required" | "auto-accept-edits" | "auto" | "full-access";

const b64url = (bytes: Buffer) => bytes.toString("base64url");

/** A pairing code minted by a paired client (`POST /api/auth/pairing-token`); with `access`, bound to that level. */
export const mintPairingCode = async (
  cookie: string,
  options: { readonly access?: LinkAccess; readonly label?: string; readonly scopes?: ReadonlyArray<string> } = {},
  at: URL = base,
) => {
  const response = await fetch(new URL("/api/auth/pairing-token", at), {
    method: "POST",
    headers: { cookie, origin: at.origin, "content-type": "application/json" },
    body: JSON.stringify({
      ...(options.access ? { access: options.access } : {}),
      ...(options.label ? { label: options.label } : {}),
      ...(options.scopes ? { scopes: options.scopes } : {}),
    }),
  });
  const json = (await response.json().catch(() => undefined)) as { credential?: string; access?: string } | undefined;
  if (response.status !== 200 || json?.credential === undefined) throw new Error(`pairing-token: HTTP ${response.status}`);
  return { code: json.credential, access: json.access };
};

export interface SignInAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** One OAuth step's answer, raw: the tests read refusals as well as successes. */
const post = async (at: URL, pathname: string, body: unknown, form = false): Promise<SignInAnswer> => {
  const response = await fetch(new URL(pathname, at), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
    body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text.slice(0, 500);
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: kept as text.
  }
  return { status: response.status, body: parsed };
};

/** Registers an MCP OAuth client: a Peer link's (`software_id`), or with `peerLink: false` an outside app's. */
export const registerPeerClient = (clientName = "t3flare step 3 harness", at: URL = base, peerLink = true) =>
  post(at, "/oauth/mcp/register", {
    client_name: clientName,
    redirect_uris: [PEER_LINK_REDIRECT_URI],
    ...(peerLink ? { software_id: PEER_LINK_SOFTWARE_ID } : {}),
  });

/** The decision step alone, with any code (the F11 and cap checks send what a client would not). */
export const decide = async (clientId: string, code: string, access: LinkAccess, at: URL = base) => {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const answer = await post(at, "/oauth/mcp/decision", {
    authorization: {
      response_type: "code",
      client_id: clientId,
      redirect_uri: PEER_LINK_REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: `${at.origin}/mcp`,
    },
    decision: { _tag: "pairing-code", access, code },
  });
  return { answer, verifier, state };
};

export class LinkError extends Error {
  readonly step: string;
  readonly answer: SignInAnswer;
  constructor(step: string, answer: SignInAnswer) {
    super(`peer link ${step}: HTTP ${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`);
    this.step = step;
    this.answer = answer;
  }
}

/** `PeerLinks.signIn`: register, decide with the pairing code, exchange. The link's bearer token (30 days). */
export const signIn = async (
  code: string,
  access: LinkAccess,
  options: { readonly at?: URL; readonly peerLink?: boolean; readonly clientName?: string } = {},
): Promise<{ readonly token: string; readonly scope: string; readonly clientId: string }> => {
  const at = options.at ?? base;
  const registered = await registerPeerClient(options.clientName ?? "t3flare step 3 harness", at, options.peerLink ?? true);
  const clientId = (registered.body as { client_id?: string }).client_id;
  if (registered.status >= 300 || clientId === undefined) throw new LinkError("register", registered);
  const { answer, verifier, state } = await decide(clientId, code, access, at);
  const redirectTo = (answer.body as { redirectTo?: string }).redirectTo;
  if (answer.status !== 200 || redirectTo === undefined) throw new LinkError("decision", answer);
  const redirect = new URL(redirectTo);
  const authCode = redirect.searchParams.get("code");
  if (authCode === null || redirect.searchParams.get("state") !== state) throw new LinkError("decision", answer);
  const token = await post(
    at,
    "/oauth/mcp/token",
    { grant_type: "authorization_code", code: authCode, redirect_uri: PEER_LINK_REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource: `${at.origin}/mcp` },
    true,
  );
  const body = token.body as { access_token?: string; scope?: string };
  if (token.status !== 200 || body.access_token === undefined) throw new LinkError("token", token);
  return { token: body.access_token, scope: body.scope ?? "", clientId };
};

export interface McpAnswer {
  readonly status: number;
  readonly sessionId?: string;
  readonly contentType: string;
  /** The JSON-RPC message (a JSON body, or the one SSE event's data). */
  readonly message?: { readonly result?: any; readonly error?: { readonly code: number; readonly message: string } } | undefined;
  readonly text: string;
}

/** A JSON-RPC message from a JSON body or an SSE stream's `data:` lines. */
export const parseMcp = (contentType: string, text: string): McpAnswer["message"] => {
  if (contentType.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line !== "");
    const last = data.at(-1);
    return last === undefined ? undefined : JSON.parse(last);
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A tool's answer as t3 shapes it: the text of its content, and whether it is an error (a refusal's code in it). */
export interface ToolAnswer {
  readonly http: number;
  readonly isError: boolean;
  readonly text: string;
  readonly json: any;
  readonly rpcError?: { readonly code: number; readonly message: string };
}

/** An MCP client of `/mcp` with a bearer, as `PeerMcpClient` is: one session, re-initialised on a 404. */
export class McpClient {
  readonly #token: string;
  readonly #at: URL;
  #limit: string | undefined;
  #sessionId: string | undefined;
  #id = 1;
  /** Every initialisation's answer status, in order (the 404 re-initialisation check reads it). */
  readonly initialisations: Array<number> = [];

  constructor(token: string, options: { readonly modeLimit?: string; readonly at?: URL } = {}) {
    this.#token = token;
    this.#at = options.at ?? base;
    this.#limit = options.modeLimit;
  }

  set modeLimit(limit: string | undefined) {
    this.#limit = limit;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** One POST; `sessionId` null sends none (an initialisation), undefined the current one. */
  async raw(message: unknown, session?: string | null): Promise<McpAnswer> {
    const sessionId = session === null ? undefined : (session ?? this.#sessionId);
    const response = await fetch(new URL("/mcp", this.#at), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${this.#token}`,
        ...(this.#limit === undefined ? {} : { "t3-mode-limit": this.#limit }),
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId, "mcp-protocol-version": MCP_PROTOCOL_VERSION }),
      },
      body: JSON.stringify(message),
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const id = response.headers.get("mcp-session-id") ?? undefined;
    return { status: response.status, contentType, text, ...(id === undefined ? {} : { sessionId: id }), message: parseMcp(contentType, text) };
  }

  async initialize(): Promise<McpAnswer> {
    const answer = await this.raw(
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t3flare-peer-harness", version: "1" } } },
      null,
    );
    this.initialisations.push(answer.status);
    if (answer.status === 200 && answer.sessionId !== undefined) {
      this.#sessionId = answer.sessionId;
      await this.raw({ jsonrpc: "2.0", method: "notifications/initialized" });
    }
    return answer;
  }

  /** One JSON-RPC request; a 404 (the peer restarted) re-initialises once and sends it again. */
  async request(method: string, params: unknown): Promise<McpAnswer> {
    if (this.#sessionId === undefined) {
      const init = await this.initialize();
      if (init.status !== 200) return init;
    }
    let answer = await this.raw({ jsonrpc: "2.0", id: this.#id++, method, params });
    if (answer.status === 404) {
      const init = await this.initialize();
      if (init.status !== 200) return init;
      answer = await this.raw({ jsonrpc: "2.0", id: this.#id++, method, params });
    }
    return answer;
  }

  async listTools(): Promise<ReadonlyArray<{ readonly name: string; readonly annotations?: Record<string, unknown> }>> {
    const answer = await this.request("tools/list", {});
    return answer.message?.result?.tools ?? [];
  }

  async call(tool: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const answer = await this.request("tools/call", { name: tool, arguments: args });
    const result = answer.message?.result;
    const text = Array.isArray(result?.content) ? result.content.map((part: { text?: string }) => part.text ?? "").join("") : answer.text.slice(0, 2000);
    let json: any;
    try {
      json = result?.structuredContent ?? JSON.parse(text);
    } catch {
      json = undefined;
    }
    return {
      http: answer.status,
      isError: result?.isError === true || answer.status !== 200 || answer.message?.error !== undefined,
      text,
      json,
      ...(answer.message?.error === undefined ? {} : { rpcError: answer.message.error }),
    };
  }

  /**
   * `t3_thread_wait` in pieces of at most WAIT_CHUNK_MS from the start, as `PeerForwarding` waits, until the answer
   * is not a timeout or `totalMs` passes.
   */
  async waitThread(args: Record<string, unknown>, totalMs: number): Promise<{ readonly answer: ToolAnswer; readonly pieces: number }> {
    const started = Date.now();
    let pieces = 0;
    for (;;) {
      const left = totalMs - (Date.now() - started);
      const answer = await this.call("t3_thread_wait", { ...args, timeoutMs: Math.max(1000, Math.min(WAIT_CHUNK_MS, left)) });
      pieces++;
      if (answer.isError || answer.json?.timedOut !== true || Date.now() - started >= totalMs) return { answer, pieces };
    }
  }
}
