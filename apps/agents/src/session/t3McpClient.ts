// The Session's MCP client of t3's `/mcp` (step 3, plan section 4.2; ADR-0022), over the Environment DO's `mcp` RPC
// rather than HTTP: one MCP session per credential, kept in memory, initialised again when t3 answers 404 (the
// Environment restarted), as t3's `PeerMcpClient` does. A 401 means the credential is gone (an Environment restart, the
// provider session released): t3's tools are unavailable until the next turn brings a fresh one.
// @effect-diagnostics asyncFunction:off globalConsole:off
import type { McpRpcAnswer, McpRpcRequest, T3McpCredential } from "@t3flare/session-protocol";

import type { CatalogTool, McpCallAnswer } from "../extensions/t3-mcp.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const UNAVAILABLE = "T3's tools are unavailable until the next turn (T3 restarted or ended this provider session). Do not retry now.";

interface JsonRpcMessage {
  readonly result?: { readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string; readonly data?: string; readonly mimeType?: string }>; readonly isError?: boolean; readonly tools?: ReadonlyArray<CatalogTool>; readonly structuredContent?: unknown };
  readonly error?: { readonly code: number; readonly message: string };
}

/** The JSON-RPC message of an answer: its JSON body, or its SSE stream's last `data:` event. */
export const messageOf = (answer: McpRpcAnswer): JsonRpcMessage | undefined => {
  const text = answer.contentType.includes("text/event-stream")
    ? answer.body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line !== "")
        .at(-1)
    : answer.body;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as JsonRpcMessage;
  } catch {
    return undefined;
  }
};

/** G11 (R6): the image types a model reads, and how many and how large a tool result may carry, as pi's `read` bounds one. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_RESULT_IMAGES = 4;
/** Base64 characters of one image: 5 MiB, the most a provider takes. */
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;

/** The MCP `image` parts of a tool result a model can see: t3's `html_preview` and `preview_snapshot` screenshots. */
export const imagesOf = (content: ReadonlyArray<{ readonly type?: string; readonly text?: string; readonly data?: string; readonly mimeType?: string }>): ReadonlyArray<{ readonly data: string; readonly mimeType: string }> =>
  content
    .filter((part) => part.type === "image" && typeof part.data === "string" && part.data.length <= MAX_IMAGE_BASE64 && IMAGE_TYPES.has(part.mimeType ?? ""))
    .slice(0, MAX_RESULT_IMAGES)
    .map((part) => ({ data: part.data!, mimeType: part.mimeType! }));

export class T3McpClient {
  readonly #post: (input: McpRpcRequest) => Promise<McpRpcAnswer>;
  readonly #credential: () => T3McpCredential | undefined;
  /** MCP session ids by credential (the authorization header): memory only. */
  readonly #sessions = new Map<string, string>();
  #id = 1;

  constructor(post: (input: McpRpcRequest) => Promise<McpRpcAnswer>, credential: () => T3McpCredential | undefined) {
    this.#post = post;
    this.#credential = credential;
  }

  async #initialize(authorization: string): Promise<McpRpcAnswer> {
    const answer = await this.#post({
      authorization,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t3flare-session", version: "1" } },
      }),
    });
    if (answer.status === 200 && answer.sessionId !== undefined) {
      this.#sessions.set(authorization, answer.sessionId);
      await this.#post({
        authorization,
        sessionId: answer.sessionId,
        protocolVersion: MCP_PROTOCOL_VERSION,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
    }
    return answer;
  }

  /** One request with the current credential; a 404 initialises again once. Undefined without a credential. */
  async request(method: string, params: unknown): Promise<McpRpcAnswer | undefined> {
    const credential = this.#credential();
    if (credential === undefined) return undefined;
    const { authorization } = credential;
    const send = async (): Promise<McpRpcAnswer> => {
      let sessionId = this.#sessions.get(authorization);
      if (sessionId === undefined) {
        const init = await this.#initialize(authorization);
        if (init.status !== 200) return init;
        sessionId = this.#sessions.get(authorization);
      }
      return this.#post({
        authorization,
        protocolVersion: MCP_PROTOCOL_VERSION,
        ...(sessionId === undefined ? {} : { sessionId }),
        body: JSON.stringify({ jsonrpc: "2.0", id: this.#id++, method, params }),
      });
    };
    let answer = await send();
    if (answer.status === 404) {
      this.#sessions.delete(authorization);
      answer = await send();
    }
    return answer;
  }

  /** t3's tools for this credential (`tools/list`), or undefined when t3 did not answer with them. */
  async listTools(): Promise<ReadonlyArray<CatalogTool> | undefined> {
    const answer = await this.request("tools/list", {});
    if (answer === undefined || answer.status !== 200) return undefined;
    return messageOf(answer)?.result?.tools;
  }

  async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpCallAnswer> {
    const answer = await this.request("tools/call", { name, arguments: args }).catch((error: unknown) => {
      console.warn(JSON.stringify({ t3flare: "t3-mcp-call-failed", tool: name, error: String(error).slice(0, 300) }));
      return undefined;
    });
    if (answer === undefined || answer.status === 401) return { kind: "unavailable", message: UNAVAILABLE };
    if (answer.status !== 200) return { kind: "result", text: `T3 answered HTTP ${answer.status}.`, isError: true };
    const message = messageOf(answer);
    if (message?.error !== undefined) return { kind: "result", text: message.error.message, isError: true };
    const content = message?.result?.content ?? [];
    const text = content.map((part) => part.text ?? "").join("");
    const images = imagesOf(content);
    return { kind: "result", text, isError: message?.result?.isError === true, ...(images.length === 0 ? {} : { images }) };
  }
}
