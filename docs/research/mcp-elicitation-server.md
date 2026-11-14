# MCP elicitation from a hand-written server: spec, transport, security, clients

Research date: 2026-11-14. Target: a hand-written MCP server (no SDK) in a Durable Object behind a Worker that asks the user to confirm some `tools/call`s through elicitation while the call is in flight.

Conventions:
- Every claim cites a primary URL (spec pages, spec schema, TypeScript SDK source, client docs or client source). Spec pages are fetched from `modelcontextprotocol.io`; schema from `raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/<version>/schema.ts`.
- **DOCUMENTED** = stated in a primary source I read. **INFERRED** = my reading of documented facts. **UNKNOWN** = no primary evidence found.
- Quoted spec text is verbatim from the page cited.
- Repo files are cited by path; they are not primary sources.

---

## 0. Which spec version is which

| Version | Elicitation | Transport model for server→client requests | Source |
|---|---|---|---|
| 2025-03-26 | None. The elicitation page for this version returns 404. | Server may send requests on SSE streams (see §2). | 2025-06-18 changelog item 6 ("Add support for elicitation"); https://modelcontextprotocol.io/specification/2025-06-18/changelog ; 404 at https://modelcontextprotocol.io/specification/2025-03-26/client/elicitation |
| 2025-06-18 | Form mode only. Introduced here. | Same as 2025-03-26. | https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation |
| 2025-11-25 | Adds **URL mode**, `notifications/elicitation/complete`, and `URLElicitationRequiredError` (-32042). | Same as 2025-03-26. | Changelog item 6: https://modelcontextprotocol.io/specification/2025-11-25/changelog ; https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation |
| **2026-07-28** (current per the versioning page, fetched 2026-11-14) | Form and URL mode, but elicitation is carried inside results (MRTR). URL mode loses `elicitationId`; the completion notification is removed. | **No server-initiated requests at all.** Server returns `InputRequiredResult`; client retries the call. Sessions, GET stream and SSE resumability removed. | https://modelcontextprotocol.io/specification/versioning ; 2026 changelog items 1, 2, 7, 9, 11: https://modelcontextprotocol.io/specification/2026-07-28/changelog |

- DOCUMENTED: the 2026-07-28 changelog says the MRTR pattern "replaces the previous approach of sending server-initiated requests" and that `notifications/elicitation/complete` and the URL-mode `elicitationId` were removed. (https://modelcontextprotocol.io/specification/2026-07-28/changelog, items 7 and 11.)
- DOCUMENTED: the 2026-07-28 MRTR page says "Servers **MUST** send server-to-client requests (such as `roots/list`, `sampling/createMessage`, or `elicitation/create`) using the MRTR pattern. The previous pattern of server-initiated requests is no longer supported. This is a breaking change." (https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
- UNKNOWN: whether draft pages (https://modelcontextprotocol.io/specification/draft/client/elicitation) differ from 2026-07-28. I did not diff them. The llms.txt index lists SEP-2260 (Final) and SEP-2567 / SEP-2575 / SEP-2322 as the relevant SEPs.

---

## 1. Elicitation modes, shapes, actions, capabilities

### 1a. Form mode

- DOCUMENTED (2025-11-25 and 2026-07-28): form request params are `mode` (optional; `"form"` if omitted), `message` (required), `requestedSchema` (required). Clients MUST treat a request with no `mode` as form mode. (https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation ; 2025-11-25 same page.)
- DOCUMENTED: `requestedSchema` is "a restricted subset of JSON Schema", flat object, top-level properties only, primitives only: string (`minLength`, `maxLength`, `format` in `email|uri|date|date-time`, `default`), number/integer (`minimum`, `maximum`, `default`), boolean, and enums (single and multi, with or without `oneOf`/`anyOf` titles). Nested objects and arrays of objects are not allowed. (2026-07-28 elicitation page, "Requested Schema".)
- DOCUMENTED: `ElicitRequestFormParams.requestedSchema` is typed `{ type: "object"; properties: {...}; required?: string[] }`. (https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts, around line 2799.)
- DOCUMENTED: an empty `properties` object is valid. The spec does not call it a "confirm" request. (schema, `ElicitRequestFormParams`.)
- INFERRED: a confirm dialog is a form with an empty or single boolean `requestedSchema`. Client-side code in Codex treats an empty-schema form as an approval (see §5, Codex).

### 1b. URL mode (2025-11-25 and later)

- DOCUMENTED, 2025-11-25: URL params are `mode: "url"`, `message`, `url`, and `elicitationId` (all required). (https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation ; schema `ElicitRequestURLParams` at 2025-11-25 `schema.ts` ~line 2185.)
- DOCUMENTED, 2026-07-28: URL params are `mode: "url"`, `message`, `url`. No `elicitationId`. (schema `ElicitRequestURLParams` at 2026-07-28 `schema.ts` ~line 2832.)
- DOCUMENTED: "The `url` parameter **MUST** contain a valid URL." (both versions.)
- DOCUMENTED: "URL mode elicitation is *not* for authorizing the MCP client's access to the MCP server." The client's bearer token remains unchanged. (both versions.)

### 1c. Responses and actions

- DOCUMENTED: `ElicitResult` is `{ action: "accept" | "decline" | "cancel", content? }`. (2026 schema `ElicitResult`, ~line 3145.)
- DOCUMENTED: `accept` = "User explicitly approved and submitted with data". For form mode `content` holds the data. For URL mode `content` is omitted. (2026 elicitation page, "Response Actions".)
- DOCUMENTED: `decline` = "User explicitly declined the request". `cancel` = "User dismissed without making an explicit choice" (Escape, closed dialog, browser failed to load). (same.)
- DOCUMENTED, URL mode: "The response with `action: "accept"` indicates that the user has consented to the interaction. It does not mean that the interaction is complete." (2026 and 2025-11-25 elicitation pages.)
- DOCUMENTED: `content` values are `string | number | boolean | string[]`. (2026 schema `ElicitResult`.)
- DOCUMENTED: "Servers **SHOULD NOT** assume that elicitation requests will always succeed, and **MUST** handle cases where the user declines or cancels the elicitation, or where the client fails to process the request." (2026 elicitation page, "Error Handling".)

### 1d. Completion notification (URL mode, 2025-11-25 only)

- DOCUMENTED, 2025-11-25: `notifications/elicitation/complete` with params `{ elicitationId }`. Servers MAY send it; "**MUST** only send the notification to the client that initiated the elicitation request"; "**MUST** include the `elicitationId`"; clients "**MUST** ignore notifications referencing unknown or already-completed IDs." (2025-11-25 elicitation page, "Completion Notifications".)
- DOCUMENTED, 2026-07-28: removed. "Under the MRTR pattern, the client learns the outcome of an out-of-band interaction by retrying the original request." Servers encode their own identifier in `requestState`. (2026 changelog item 11.) Confirmed absent from the 2026 `schema.ts` (grep for `elicitation/complete` returns nothing).
- DOCUMENTED, 2025-11-25: `URLElicitationRequiredError` (-32042) "**MUST** include a list of elicitations ... Any elicitations returned in the error **MUST** be URL mode elicitations and have an `elicitationId` property." (2025-11-25 elicitation page; schema line ~181.) Not present in 2026 (the 2026 schema says -32042 is "2025-11-25 only").

### 1e. Capability declaration

- DOCUMENTED, 2025-11-25: at `initialize`, `capabilities.elicitation` = `{ "form": {}, "url": {} }`. Empty `{}` is "equivalent to declaring support for `form` mode only". A client that declares elicitation "**MUST** support at least one mode". (2025-11-25 elicitation page, "Capabilities".)
- DOCUMENTED, 2026-07-28: declared on every request in `params._meta["io.modelcontextprotocol/clientCapabilities"].elicitation`. Same `form`/`url` shape and `{}` = form. (2026 elicitation page, "Capabilities".)
- DOCUMENTED, TS SDK `getSupportedElicitationModes`: empty object → form; URL only if `url` is present. (https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/client/src/client/client.ts, lines 158–183.)

### 1f. What a server must do if the client did not declare it

- DOCUMENTED, 2025-11-25: "Servers **MUST NOT** send elicitation requests with modes that are not supported by the client." A client that receives one for an undeclared mode returns `-32602`. (2025-11-25 elicitation page.)
- DOCUMENTED, 2025-06-18: only "Clients that support elicitation **MUST** declare the `elicitation` capability." No explicit server-side rule. (https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation.) → INFERRED: a server must not send it.
- DOCUMENTED, 2026-07-28: "Servers **MUST NOT** send an `inputRequests` that the client has not declared support for in its capabilities. For example, if a client does not declare support for `elicitation`, the server **MUST NOT** include any `elicitation/create` requests." (MRTR page, server requirement 7.)
- DOCUMENTED, 2026-07-28: "A server **MUST NOT** rely on capabilities the client has not declared. If processing a request requires a capability the client did not include ... the server **MUST** return a `MissingRequiredClientCapabilityError` (`-32021`) ... On HTTP, the response status **MUST** be `400 Bad Request`." (https://modelcontextprotocol.io/specification/2026-07-28/basic/index, "Per-request" section.)
- DOCUMENTED, TS SDK server: `elicitInput` throws `CapabilityNotSupported` when the client lacks `elicitation.url` / `elicitation.form` (https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/src/server/server.ts, lines ~1191–1205). On a 2026 request it throws `MethodNotSupportedByProtocolVersion` instead (`_assertPushApiInServedEra`, ~line 772).

---

## 2. Streamable HTTP mechanics for a server request during `tools/call`

### 2a. 2025-03-26 through 2025-11-25 (push model)

- DOCUMENTED: the client POSTs the request with `Accept: application/json, text/event-stream`. The server answers with `Content-Type: text/event-stream` or `application/json`; the client MUST support both. (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports, "Sending Messages to the Server" items 2, 5.)
- DOCUMENTED: "The server **MAY** send JSON-RPC *requests* and *notifications* before sending the JSON-RPC *response*. These messages **SHOULD** relate to the originating client *request*." (same, item 6.)
- DOCUMENTED: the server SHOULD first send an SSE event with an event ID and empty `data`, to prime the client to reconnect. (same, item 6.)
- DOCUMENTED: the elicitation request is a JSON-RPC request with a server-assigned `id`, written onto the SSE stream of the POST that carries `tools/call`. (2025-11-25 elicitation page, "Message Flow"; the SSE rules above.)
- DOCUMENTED: the client answers with a **new HTTP POST** to the MCP endpoint whose body is the JSON-RPC **response** (`id` matching the server's request). "The body of the POST request **MUST** be a single JSON-RPC *request*, *notification*, or *response*." (2025-11-25 transports, item 3.)
- DOCUMENTED: for a response or notification POST, "the server **MUST** return HTTP status code 202 Accepted with no body." (same, item 4.)
- DOCUMENTED: each POST is its own request; there is no requirement that a response POST arrive on the same connection as the original stream. The spec does not say how a response POST is routed to the process that holds the waiting call.

**Session.**
- DOCUMENTED: "A server using the Streamable HTTP transport **MAY** assign a session ID at initialization time" via `MCP-Session-Id`. If one is assigned, the client MUST send it on later requests. Servers that require it SHOULD return 400 without it. (2025-11-25 transports, "Session Management".)
- DOCUMENTED: session IDs are optional, so a server may omit them.
- INFERRED: a stateless server can use the 2025 push model only if the response POST reaches the same instance that holds the pending `tools/call`. A Durable Object addressed per session or per endpoint satisfies that within one object. The spec doesn't address it, so this is the server's job.

**Related-request rules.**
- DOCUMENTED, 2025-11-25: GET-stream messages "**SHOULD** be unrelated to any concurrently-running JSON-RPC *request* from the client." Messages tied to a request belong on that request's stream. (2025-11-25 transports, GET item 4.)
- DOCUMENTED, SEP-2260 (status Final): "`roots/list`, `sampling/createMessage`, and `elicitation/create` requests **MUST** be associated with an originating client-to-server request ... Standalone server-initiated requests of these types outside notifications **MUST NOT** be implemented." (https://modelcontextprotocol.io/seps/2260-Require-Server-requests-to-be-associated-with-Client-requests.md.) The 2025-11-25 text only says SHOULD.

**Resumability.**
- DOCUMENTED, 2025-11-25: the server MAY make a stream resumable. Event IDs must be unique per session (or per client) and "SHOULD encode sufficient information to identify the originating stream". A client resumes with HTTP GET plus `Last-Event-ID`. "Disconnection **SHOULD NOT** be interpreted as the client cancelling its request." (2025-11-25 transports, "Resumability and Redelivery".)
- DOCUMENTED: a server closing the connection without ending the stream SHOULD first send an SSE `retry` field. (same, item 6.)

### 2b. 2026-07-28 (MRTR model)

- DOCUMENTED: no `Mcp-Session-Id`, no GET endpoint, no `Last-Event-ID`. "Removal of protocol-level sessions" and "Removal of the GET stream endpoint." (2026 transports page note.)
- DOCUMENTED: "The server **MUST NOT** send independent JSON-RPC *requests* on this stream. Server-to-client interactions (sampling, elicitation, list-roots) are embedded as input requests inside an `InputRequiredResult` per MRTR." (2026 transports, "Receiving Messages".)
- DOCUMENTED: "The client **MUST NOT** send JSON-RPC *responses*." (2026 transports, "Sending Messages" item 4.) So there is no response POST and no 202 for one.
- DOCUMENTED flow: `tools/call` (id 1) → result `{ resultType: "input_required", inputRequests: { <key>: { method: "elicitation/create", params } }, requestState? }` → client retries `tools/call` with a **new** JSON-RPC id, `params.inputResponses: { <key>: ElicitResult }`, and `params.requestState` echoed verbatim. (MRTR page, "Basic Workflow" and "Client Requirements" item 3; schema `InputResponseRequestParams`, ~lines 597–609.)
- DOCUMENTED: `tools/call` is one of three methods that may return `InputRequiredResult`. (MRTR page, "Supported Requests" table.)
- DOCUMENTED: "Servers **MUST** include at least one of `inputRequests` or `requestState` in every `InputRequiredResult` response." (MRTR page, server req 6.)
- DOCUMENTED: "If a client request contains a `requestState` field, servers **MUST** treat `requestState` as an attacker-controlled input." Integrity (HMAC or AEAD) is required if it affects authorization, resource access or logic. Servers SHOULD bind it to the authenticated principal, a short TTL, and a digest of the request. "these measures ... do not by themselves guarantee single-use." (MRTR page, server reqs 4–5.)
- DOCUMENTED: "Servers **MAY** choose to return an `InputRequiredResult` on multiple attempts at the same request." (MRTR page, server req 8.) Two rounds are normal.
- DOCUMENTED: the server must not assume the client fulfils the request; it may ask again. "If the client fails to send all the information requested ... the server **SHOULD** respond with a new `InputRequiredResult`." (MRTR page, "Error Handling".)
- DOCUMENTED: "Servers **MUST NOT** rely on prior requests over the same connection to ..." and "A server processes each request independently; no state should be inferred" (2026 basic index).
- DOCUMENTED: `requestState` and `inputRequests` "**MUST NOT** be used for any other request that the client may be sending in parallel." (MRTR page, client req 4.)

**Stateless answer.** DOCUMENTED: the 2026 model is stateless by design. "Elicitations do not require that the server maintain state about users with the MRTR mechanism." (2026 elicitation page, "Statefulness".) A stateless server can answer the retry from `requestState` alone.

**Cancellation and disconnect.**
- DOCUMENTED, 2026: "Closing the SSE response stream **MUST** be treated by the server as cancellation of that request." (2026 transports, "Cancellation".)
- DOCUMENTED, 2026-07-28 cancellation page: "The server **MUST** treat a client disconnect as cancellation of that request." Under 2025-11-25 a disconnect SHOULD NOT be read as cancellation (see §2a). The two versions differ here.
- DOCUMENTED, 2026 changelog item 9: "A broken response stream loses the in-flight request; clients **MUST** re-issue it as a new request with a new request ID."

---

## 3. Security rules

### 3a. Form mode: no secrets

- DOCUMENTED, 2025-06-18: "Servers **MUST NOT** use elicitation to request sensitive information." (2025-06-18 elicitation page, warning block.)
- DOCUMENTED, 2025-11-25 and 2026-07-28: "Servers **MUST NOT** use form mode elicitation to request sensitive information such as passwords, API keys, access tokens, or payment credentials. Servers **MUST** use URL mode for interactions involving such sensitive information." General contact or profile information "is not categorically prohibited." (both elicitation pages.)
- DOCUMENTED: clients MUST "Provide UI that makes it clear which server is requesting information", "Respect user privacy and provide clear decline and cancel options", and "For form mode, allow users to review and modify their responses before sending." (2026 elicitation page.)

### 3b. URL mode

- DOCUMENTED, 2025-11-25 and 2026: servers "**MUST NOT** include sensitive information about the end-user, including credentials, personally identifiable information, etc., in the URL." "**MUST NOT** provide a URL which is pre-authenticated to access a protected resource." "**SHOULD** use HTTPS URLs for non-development environments." (2026 elicitation page, "Safe URL Handling".)
- DOCUMENTED: clients "**MUST NOT** automatically pre-fetch the URL or any of its metadata", "**MUST NOT** open the URL without explicit consent", "**MUST** show the full URL to the user for examination before consent", "**MUST** open the URL ... in a secure manner that does not enable the client or LLM to inspect the content or user inputs", "**SHOULD** highlight the domain", "**SHOULD** have warnings for ... Punycode", "**SHOULD NOT** render URLs as clickable" except the `url` field of URL mode. (same page, client rules 1–7.)
- DOCUMENTED: "Clients **SHOULD** provide manual controls that let the user retry or cancel the original request." (2026 elicitation page, after URL-mode `accept`.)

### 3c. User identity binding and phishing (verbatim)

- DOCUMENTED, 2025-11-25 "Phishing": "URL mode elicitation returns a URL that an attacker can use to send to a victim. The MCP Server **MUST** verify the identity of the user who opens the URL before accepting information."
- DOCUMENTED, 2025-11-25: "To prevent this attack, the server **MUST** ensure that the user who started the elicitation request (the end-user who is accessing the server via the MCP client) is the same user who completes the authorization flow."
- DOCUMENTED, 2026-07-28 "Phishing" (same rule): "To prevent this attack, the server **MUST** ensure that the user who started the elicitation request ... is the same user who completes the authorization flow." Plus: "In all implementations, the server **MUST** ensure that the mechanism to determine the user's identity is resilient to attacks where an attacker can modify the elicitation URL."
- DOCUMENTED, 2025-11-25 "Statefulness": "State **MUST NOT** be associated with session IDs alone." Storage "**MUST** be protected against unauthorized access", and user identification "**MUST** be derived from credentials acquired via MCP authorization when possible (e.g. `sub` claim)."
- DOCUMENTED, 2026-07-28 "Identifying the User": "Servers **MUST NOT** rely on client-provided user identification without server verification, as this can be forged."
- DOCUMENTED, 2026 "Security Considerations" item 1: "Servers **MUST** bind elicitation requests to the client and user identity."

### 3d. Clients can auto-answer

See §6. Spec text does not require a human to answer an elicitation.

---

## 4. Timeouts

- DOCUMENTED, 2025-11-25 lifecycle "Timeouts": "Implementations **SHOULD** establish timeouts for all sent requests ... the sender **SHOULD** issue a cancellation notification ... SDKs ... **SHOULD** allow these timeouts to be configured on a per-request basis." Progress: "Implementations **MAY** choose to reset the timeout clock when receiving a progress notification corresponding to the request ... implementations **SHOULD** always enforce a maximum timeout, regardless of progress notifications." (https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle.)
- DOCUMENTED, 2026-07-28 cancellation page "Timeouts": same rules. (https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation.)
- DOCUMENTED, 2026 progress: "The server **MAY** ... choose not to send any progress notifications." Progress notifications must relate to the request's `progressToken`. (https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress.)
- DOCUMENTED, TS SDK: `DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000` (`packages/core-internal/src/shared/protocol.ts` line 112). Options `timeout`, `maxTotalTimeout`, and `resetTimeoutOnProgress` (default `false`, line 1662 `options?.resetTimeoutOnProgress ?? false`). On progress with the flag set, the timer resets (`_onprogress`, line 1246), capped by `maxTotalTimeout`.
- DOCUMENTED, 2026 MRTR: each round is a separate request, so the human wait is spent between requests and is not inside one open request. (INFERRED consequence: client per-request timeouts apply to each round, not to the human wait.)

Client defaults:

| Client | Tool-call timeout | Progress resets it? | Source |
|---|---|---|---|
| TS SDK (default) | 60 s | Only with `resetTimeoutOnProgress: true` | protocol.ts lines 112, 1662 |
| Claude Code | Per-server `timeout`; default `MCP_TOOL_TIMEOUT` ≈ 28 h. For HTTP/SSE/connectors, a per-request timer runs to the first response byte, set to max(60 s, tool timeout, `MCP_TIMEOUT`). | No: "a hard wall-clock limit per tool call, and progress notifications from the server don't extend it." | https://code.claude.com/docs/en/mcp, "Time limits on MCP tool calls" |
| Codex CLI | `tool_timeout_sec`, default 60 | UNKNOWN | https://developers.openai.com/codex/mcp (config table) |
| OpenCode | `execution` 12 h; `startup` and `catalog` 30 s | UNKNOWN | https://opencode.ai/docs/mcp-servers/ "Timeouts" |
| Pi (built-in) | `timeout`, default 60 s | Yes: "Progress notifications reset it." | local pi docs `docs/mcp.md` |
| Cursor | UNKNOWN (no timeout text in https://cursor.com/docs/context/mcp) | UNKNOWN | — |
| VS Code / Copilot | UNKNOWN in https://code.visualstudio.com/api/extension-guides/ai/mcp | UNKNOWN | — |

- INFERRED: a 2025-style wait for a human under Codex's default 60 s or TS SDK's 60 s would time out unless progress resets it. Claude Code's ~28 h default is the only documented client that tolerates a long wait.

---

## 5. Client support, form and URL mode, over remote HTTP

Official MCP client matrix: https://modelcontextprotocol.io/extensions/client-matrix covers extensions only (MCP Apps, auth, Skills, Tasks). It has no elicitation column. (DOCUMENTED absence.)

| Client | Form | URL | Evidence (primary unless marked) | Notes |
|---|---|---|---|---|
| **Claude Code** | Yes | Yes | https://code.claude.com/docs/en/mcp, "Respond to MCP elicitation requests" and "Elicitation modes Claude Code declares" | Declares `elicitation: {form:{}, url:{}}` on 2026-07-28 connections, and on ≤2025-11-25 connections to stdio, sse, http, ws servers (v2.1.287+). Declares bare `{}` (form only) to claude.ai connectors on older revisions. Dialog in terminal; cloud sessions answer on a card at claude.ai/code or the Desktop Code tab. |
| **Claude Desktop / claude.ai (chat)** | UNKNOWN | UNKNOWN | Remote connectors help: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp (no elicitation text). Third-party matrix https://canimcp.dev/feature/elicitation.url lists claude.ai as "Unknown" for URL mode (third-party, not verified). | The Claude Code doc above describes Claude Code's own connection to connectors, not the chat app. |
| **Codex CLI** | Yes (source) | Yes in source; declined under `approval_policy = "never"` (source + issue) | Source: https://raw.githubusercontent.com/openai/codex/main/codex-rs/codex-mcp/src/elicitation.rs, lines ~574–612 (empty-schema forms auto-accepted only when permission prompt is auto-approved; `elicitation_is_rejected_by_policy` declines when `approval_policy = Never`, lines ~605–612, 707–709), lines ~648–661 (`UrlElicitationParams` → `ElicitationRequest::Url`), lines ~662–668 (other variants declined). Issue: https://github.com/openai/codex/issues/45776 (filed 2026-09-15, describes the same auto-decline with app-server). | Docs https://developers.openai.com/codex/mcp do not mention elicitation (UNKNOWN from docs). Codex source is `main` as fetched 2026-11-14; not pinned to a release. 2026-07-28 support: UNKNOWN. |
| **Cursor** | Supported (per table) | UNKNOWN | https://cursor.com/docs/context/mcp, "Protocol and extension support" table: "Elicitation | Supported | Server-initiated requests for additional information from users". | No mode split in docs. Streamable HTTP supported. |
| **VS Code GitHub Copilot** | Yes | Yes | https://code.visualstudio.com/api/extension-guides/ai/mcp, "Elicitation": "Copilot supports form and URL elicitation during an active turn. Requests are canceled in Autopilot and declined when there is no active turn." The page covers the Copilot harness (VS Code, Copilot CLI, Copilot app). | Third-party matrix says VS Code v1.107 supports URL mode (https://canimcp.dev/feature/elicitation.url). Not checked against VS Code release notes (UNKNOWN from primary). |
| **OpenCode** | Yes | Yes | https://opencode.ai/docs/mcp-servers/, "Input requests": "OpenCode shows the request as a form, or as a link to open for URL requests ... Dismissing the form cancels the request." Source https://github.com/anomalyco/opencode/blob/dev/packages/core/src/mcp/index.ts, lines ~480–512 (URL form with `elicitationId` correlation marked "Legacy only"). | Default protocol is the 2025 `initialize` handshake. 2026-07-28 is opt-in per server via `protocol` (docs, "Protocol version"). |
| **pi (built-in, 1.5.2)** | No evidence | No evidence | Shipped docs `/Users/ianpascoe/.local/share/mise/installs/pi/1.5.2/pi/docs/mcp.md` do not mention elicitation. A case-insensitive grep of the whole install directory for "elicit" returns no matches. | → INFERRED: built-in pi does not offer elicitation. |
| **pi (third-party adapter `pi-mcp`)** | Yes (TUI) | Yes (TUI only) | https://github.com/pixu1980/pi-coding-agent-extensions/blob/main/packages/pi-mcp/README.md: "When Pi exposes dialog-capable UI, the adapter advertises form elicitation support." "URL mode is advertised only in TUI mode ... always requires consent before opening the browser." | Third-party README; source not reviewed. |
| Microsoft 365 Copilot, Goose, ChatGPT, Windsurf, Zed, Gemini CLI, others | UNKNOWN | UNKNOWN | No primary evidence read. | — |

Summary for the matrix:
- DOCUMENTED with primary evidence for both modes: Claude Code, VS Code (Copilot harness), OpenCode.
- DOCUMENTED form-only or unknown mode split: Cursor.
- Source-level evidence, not verified in a release: Codex CLI.
- No elicitation in the built-in client: pi (INFERRED from absence).

---

## 6. Can a client answer without a human?

- DOCUMENTED, tools: "For trust & safety and security, there **SHOULD** always be a human in the loop with the ability to deny tool invocations." (2025-11-25 and 2026-07-28 `server/tools` pages, the warning block.) Same wording for sampling: "a human in the loop with the ability to deny sampling requests." (2025-11-25 `client/sampling`.) These apply to tool invocation and sampling, not to elicitation by name.
- DOCUMENTED, elicitation: clients MUST provide UI, MUST provide decline/cancel options, SHOULD implement user approval controls, SHOULD allow users to decline at any time. (2026 elicitation page, "Security Considerations" and client rules.)
- INFERRED: the spec does not guarantee that a human answers an elicitation. It requires the UI and the options, but does not forbid policy-based answers. The `SHOULD` language is the only hard-ish requirement.
- DOCUMENTED client auto-answers:
  - Claude Code: an `Elicitation` hook can "answer the request for the user, decline or cancel it, or leave it to the dialog ... The server gets your answer and no dialog appears." (https://code.claude.com/docs/en/hooks, `Elicitation`, lines ~3700–3790.) In a non-interactive session Claude Code cancels tasks that need input, without running hooks (https://code.claude.com/docs/en/mcp, "Time limits" / Tasks section).
  - VS Code / Copilot: "Requests are canceled in Autopilot and declined when there is no active turn." (Copilot harness docs above.)
  - Codex: with `approval_policy = Never` and auto-approved permission prompts, empty-schema forms are accepted with `content: {}` and URL requests are declined (source above, lines ~574–580, 605–612).
- INFERRED design consequence: a `decline`, `cancel` or `accept` from a client is not, by itself, proof of a human decision. A server that gates a write on an elicitation answer should also bind the answer to its own state (for example `requestState` in MRTR) and, for high-stakes actions, confirm through a server-controlled page with the user's own session (URL mode plus the §3c identity check).

---

## 7. What this means for the hand-written server (INFERRED unless marked)

1. **Target 2026-07-28 MRTR for stateless DOs.** The server returns `input_required` from `tools/call`, holds nothing, and reads `requestState` on retry. A DO does not have to keep a request open for a human (the Cloudflare lifecycle rules in `docs/research/cloudflare-platform-limits.md` §2 say pending RPC and I/O keep a DO active for up to 15 min per operation, so a multi-hour human wait cannot sit inside an open request). DOCUMENTED for the 2026 wording; the DO constraint is from that repo doc, not re-verified here.
2. **2025 push mode needs a held `tools/call`.** The server keeps the SSE response open until the response POST arrives. That is the only way to use the 2025 flow, and it hits the Codex/TS-SDK 60 s defaults and the DO lifetime limits. Resumability (`Last-Event-ID`) is optional in 2025 and gone in 2026, so a dropped stream loses the call.
3. **Server must bind `requestState`** (principal, TTL, request digest, integrity) per the MRTR page. Single-use needs a server-side record.
4. **Protocol version gate.** The 2026 client sends `io.modelcontextprotocol/protocolVersion` in `_meta` on every request, and the server must check `io.modelcontextprotocol/clientCapabilities.elicitation` on each request before sending `inputRequests`. Missing capability → `-32021`, HTTP 400.
5. **Repo state.** `apps/environment/src/mcp/relay.ts` offers `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` (`RELAY_PROTOCOL_VERSIONS`), declares only `tools` and never sends elicitation (its header says "stateless, tools only, never an elicitation"). Adding 2026-07-28 would need `server/discover`, `_meta` handling and `resultType` on every result (2026 changelog items 2–3, 8). `apps/environment/src/mcp/elicitation.ts` is the consumer side: it turns an upstream server's form or URL elicitation into t3 cards (form with fields → `user_input`; empty form and URL → approval card; URL must be HTTPS, not private, not t3flare's own host).
6. **Precedent in the repo.** `docs/steps/tools-plan.md` (lines ~96, 345, 355) plans Commissary's approval rule to answer 2026 clients that declare form elicitation with an `input_required` result plus `requestState`, and to answer 2025 clients with text. `apps/mcp-worker/src/engine/calls.ts` lines ~609–712 already resumes `input_required` on the client side. These are repo docs and code, not primary sources.

---

## Sources (fetched 2026-11-14)

- MCP spec pages: https://modelcontextprotocol.io/specification/{2025-06-18,2025-11-25,2026-07-28}/… (client/elicitation, basic/transports, basic/lifecycle, basic/patterns/mrtr, basic/patterns/progress, basic/patterns/cancellation, basic/index, basic/versioning, changelog, server/tools, client/sampling). Version list: https://modelcontextprotocol.io/specification/versioning
- Schema: https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/{2025-11-25,2026-07-28}/schema.ts
- SEPs: https://modelcontextprotocol.io/seps/2260-Require-Server-requests-to-be-associated-with-Client-requests.md (Final). SEP-2322, 2567, 2575 are referenced by the 2026 changelog and not read in full.
- TypeScript SDK (main, fetched 2026-11-14): `packages/core-internal/src/shared/protocol.ts`, `packages/client/src/client/client.ts`, `packages/server/src/server/server.ts`, `docs/protocol-versions.md`
- Clients: https://code.claude.com/docs/en/mcp ; https://code.claude.com/docs/en/hooks ; https://developers.openai.com/codex/mcp ; https://github.com/openai/codex/issues/45776 ; https://raw.githubusercontent.com/openai/codex/main/codex-rs/codex-mcp/src/elicitation.rs ; https://cursor.com/docs/context/mcp ; https://code.visualstudio.com/api/extension-guides/ai/mcp ; https://opencode.ai/docs/mcp-servers/ ; https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/mcp/index.ts ; local pi docs `docs/mcp.md` ; https://github.com/pixu1980/pi-coding-agent-extensions/blob/main/packages/pi-mcp/README.md (third-party)
- Third-party, low trust, used only to flag gaps: https://canimcp.dev/feature/elicitation.url
