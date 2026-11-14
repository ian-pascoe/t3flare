// @effect-diagnostics globalDate:off
// The Owner-client endpoint over one Environment's Settings server (settingsFixture), for M5a's tests (SPI-1200): its key
// fixed, its holds short, and requests as the named clients send them (M0's capture, P17).
import { applyMcpChange, type McpServerSetting } from "@t3flare/harness-registry";

import { type EndpointCaller, type EndpointDeps, handleSettingsMcp, MODERN_VERSION } from "../src/settings/endpoint.ts";
import type { SettingsFixture } from "./settingsFixture.ts";

export const SUB = "owner-sub";
export const OWNER: EndpointCaller = { kind: "owner", subject: SUB };
export const ENDPOINT = "https://t3.example.dev/_t3flare/mcp";
export const FREE = { expectedRevision: 0, settings: { containerIdleMinutes: 7 } };
export const ASKED = { expectedRevision: 0, settings: { containerBudget: 4 } };
export const KEY = new Uint8Array(32).fill(7);

export const CLAUDE_INFO = { name: "claude-code", version: "2.1.322" };
export const BOTH = { elicitation: { form: {}, url: {} } };

/** The endpoint over `f`, its key fixed, its holds short. */
export const endpointOf =
  (f: SettingsFixture, extra: Partial<EndpointDeps> = {}) =>
  (request: Request, caller: EndpointCaller = OWNER) =>
    handleSettingsMcp(request, caller, { server: f.deps, stateKey: () => KEY, now: f.now, holdMs: 80, beatMs: 30, ...extra });

export const post = (body: unknown, options: { readonly query?: string; readonly headers?: Readonly<Record<string, string>> } = {}) =>
  new Request(`${ENDPOINT}${options.query ?? ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...options.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

export const modernMeta = (capabilities: unknown = BOTH, extra: Record<string, unknown> = {}) => ({
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientInfo": CLAUDE_INFO,
  "io.modelcontextprotocol/clientCapabilities": capabilities,
  ...extra,
});

/** A 2026 request, as Claude Code 2.1.322 sends it (M0 P17): `_meta` on every request, the version header. */
export const modern = (method: string, params: Record<string, unknown> = {}, options: { readonly capabilities?: unknown; readonly query?: string; readonly id?: number } = {}) =>
  post(
    { jsonrpc: "2.0", id: options.id ?? 1, method, params: { ...params, _meta: modernMeta(options.capabilities ?? BOTH, (params._meta as Record<string, unknown>) ?? {}) } },
    { headers: { "mcp-protocol-version": MODERN_VERSION }, ...(options.query === undefined ? {} : { query: options.query }) },
  );

/** A 2025 request on a session (`Mcp-Session-Id`). */
export const legacy = (method: string, params: Record<string, unknown> = {}, options: { readonly session?: string; readonly version?: string; readonly query?: string; readonly id?: number | string } = {}) =>
  post(
    { jsonrpc: "2.0", id: options.id ?? 1, method, params },
    {
      headers: { "mcp-protocol-version": options.version ?? "2025-11-25", ...(options.session === undefined ? {} : { "mcp-session-id": options.session }) },
      ...(options.query === undefined ? {} : { query: options.query }),
    },
  );

/** Initializes at `version` with `capabilities`; the session token the endpoint gave. */
export const initialize = async (endpoint: ReturnType<typeof endpointOf>, version: string, capabilities: unknown = BOTH, caller: EndpointCaller = OWNER) => {
  const response = await endpoint(post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: version, capabilities, clientInfo: { name: "opencode", version: "2.2.7" } } }), caller);
  return { response, session: response.headers.get("mcp-session-id") ?? "", body: (await response.json()) as { result: Record<string, unknown> } };
};

export const bodyOf = async (response: Response) => (await response.json()) as { id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };

export const structuredOf = async (response: Response) => (await bodyOf(response)).result?.structuredContent as Record<string, unknown> | undefined;

/** Sets the Settings server's access switch (plan D2). */
export const setAccess = (f: SettingsFixture, change: Partial<Pick<McpServerSetting, "enabled" | "writes">>) => {
  const applied = applyMcpChange(f.store.load(), { op: "server", server: "settings", ...change });
  if (!applied.ok) throw new Error(applied.error);
  f.store.save(applied.harness);
};
