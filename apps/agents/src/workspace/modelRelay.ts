// The model relay (SPI-1167; ADR-0016's model relay refinement), in `WorkspaceProxy`: a CLI agent in the Container sends
// its model requests to `computer.internal/t3flare/model/<endpointId>/…` with its model handle as its key. This route
// takes the handle out, asks the Workspace DO whether it names a live process here that is configured for that endpoint
// and, if so, for the endpoint's target (the Environment's `resolve`: API, base URL, headers, credential), and sends the
// request there: the path below the endpoint's id appended to its base URL, the body and the answer streamed through
// unchanged, no protocol translation. Only an allowlist of the Container's request headers goes on (`forwardedHeadersOf`:
// content negotiation and the API's own version headers), then the endpoint's headers and its credential: no header from
// the Container can route the key elsewhere at a header-routed gateway (ADR-0034 §4). Redirects are not followed. Every
// request is logged with its endpoint, status and the handle's id (its process's key), never a value. Pure, deps
// injected; a CLI adds only its own config.
//
// SPI-1172: an error answer goes back in the vendor's own shape (its status, its reset headers, its JSON with its codes),
// so the CLI reads it as it would the vendor's, with its body redacted (`relayFailures.ts`); an error event inside a
// stream is redacted the same way. Each answer is classified by the endpoint's API and auth, logged, and handed to the
// Workspace DO as the process's last answer (`outcome`: the failure, or null for a success), which the Environment's
// CLI wrapper reads when the CLI's turn fails, so t3 shows the endpoint's failure with its reset, whatever the CLI made
// of it.
//
// SPI-1168: a CLI with one base URL per process (Claude Code) uses the model-routed id `_`: the request's JSON body names
// its model as `<endpointId>/<modelId>`, and the relay sends it to that endpoint with the model's own id in its place,
// the rest of the body byte for byte (`routedBody.ts`). The handle is checked before the body is read, and its scope
// then judges the endpoint as it judges one in the path.
import { ENDPOINT_ID, type EndpointApi } from "@t3flare/models/endpoints";
import { describeFailure, type DescribedFailure, failureHeaders, readBody } from "@t3flare/models/failures";
import { redactSecrets } from "@t3flare/models/redact";
import type { EndpointFailureRecord } from "@t3flare/session-protocol";
import { credentialHeaderOf, forwardedHeadersOf, KEY_HEADERS, MODEL_RELAY_PREFIX, MODEL_ROUTED_ID, type ModelRelayTarget } from "@t3flare/models/relay";
import { HANDLE } from "@t3flare/workspace-client";

import type { HandleCaller } from "./processHost.ts";
import { oversizedError, RELAY_ERROR_BODY_BYTES, sseErrors } from "./relayFailures.ts";
import { declaredLength, MAX_ROUTED_BODY_BYTES, readCapped, type RoutedBody, routeBody } from "./routedBody.ts";
import { observeUsage } from "./relayUsage.ts";
import type { UsageEntry } from "@t3flare/models/usage";

export { MAX_ROUTED_BODY_BYTES } from "./routedBody.ts";

/** What the Workspace DO answers for a handle and an endpoint. */
export type ModelRelayGrant =
  | {
      readonly kind: "granted";
      /** The handle's id for the logs: the key of the process it was issued to. */
      readonly handleId: string;
      readonly cli: string;
      readonly workspace: string | null;
      readonly target: { readonly api: EndpointApi; readonly auth: "api-key" | "none"; readonly baseUrl: string; readonly headers: Readonly<Record<string, string>> };
    }
  /** The handle names a live process here (asked with no endpoint: a model-routed request before its body is read). */
  | { readonly kind: "known"; readonly handleId: string; readonly cli: string; readonly workspace: string | null }
  | { readonly kind: "refused"; readonly status: number; readonly message: string; readonly handleId: string | null; readonly workspace: string | null };

/** What the relay asks the Workspace DO: a handle, and the endpoint it is for (null: only whether the handle is live). */
export interface ModelRelayAsk {
  readonly handle: string | null;
  readonly endpointId: string | null;
}

export interface ModelRelayDeps {
  /** The Workspace DO's `modelRelay`: the handle's process, and the endpoint's target from the Environment. */
  readonly authorize: (input: ModelRelayAsk) => Promise<ModelRelayGrant>;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly log: (event: Record<string, unknown>) => void;
  readonly now: () => number;
  /** Records an answer's usage, read as it streams past (`relayUsage.ts`, SPI-1173). */
  readonly usage: (entry: UsageEntry) => void;
  /**
   * SPI-1172: the process's last answer, for the Workspace DO: its classified failure, or null for a success or an error
   * the table does not know (the last answer always wins). Never fails the request.
   */
  readonly outcome?: (handleId: string, failure: EndpointFailureRecord | null) => Promise<void>;
}

/** Response headers not passed back: hop-by-hop ones and cookies. */
const DROPPED_RESPONSE = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "set-cookie"]);

const PATH = new RegExp(`^${MODEL_RELAY_PREFIX.replaceAll("/", "\\/")}([^/]*)(\\/.*)?$`);

export const isModelRelayPath = (pathname: string): boolean => pathname.startsWith(MODEL_RELAY_PREFIX);

const plain = (status: number, message: string): Response =>
  new Response(`t3flare: ${message}\n`, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } });

const handleOf = (headers: Headers): string | null => {
  for (const name of KEY_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value === undefined || value === "") continue;
    const word = name === "authorization" ? /^Bearer\s+(\S+)$/i.exec(value)?.[1] : value;
    return word !== undefined && HANDLE.test(word) ? word : null;
  }
  return null;
};

/** How many decodes a segment may take to settle: more layers than that is refused (an upstream may decode them all). */
export const MAX_DECODES = 3;

/**
 * A segment decoded to its fixed point, as an upstream that decodes repeatedly might; undefined when a decode fails (a
 * malformed escape, an overlong UTF-8 byte) or it has not settled after `MAX_DECODES` decodes. Either is refused: an
 * upstream's own, laxer decoder could read something else there.
 */
const decodedSegment = (segment: string): string | undefined => {
  let decoded = segment;
  for (let round = 0; round <= MAX_DECODES; round++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return undefined;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return undefined;
};

/**
 * Whether the path below the endpoint's id could leave its base URL at an upstream that decodes it: a segment that does
 * not decode cleanly, a dot segment (also followed by a `;` parameter, as Tomcat reads `..;`, or by a `?` or `#` a re-parsing upstream would split at), or a `/`, `\` or control
 * character (a NUL a server may cut at, a CR or LF) in a segment, in any encoding. `URL` has already resolved literal and singly encoded dot segments, and turned a literal `\` into `/`.
 */
const leavesBase = (rest: string): boolean =>
  rest
    .split("/")
    .slice(1)
    .some((segment) => {
      const decoded = decodedSegment(segment);
      // oxlint-disable-next-line no-control-regex -- control characters are what this refuses
      return decoded === undefined || /^\.\.?(?:[;?#]|$)/.test(decoded) || /[/\\\u0000-\u001f\u007f]/.test(decoded);
    });

/** Only the allowed headers of the Container's request, then the endpoint's own and its credential. */
const upstreamHeaders = (incoming: Headers, target: { readonly api: EndpointApi; readonly headers: Readonly<Record<string, string>> }): { readonly headers: Headers; readonly dropped: ReadonlyArray<string> } => {
  const allowed = forwardedHeadersOf(target.api);
  const headers = new Headers();
  const dropped: Array<string> = [];
  for (const [name, value] of incoming) {
    if (allowed.has(name)) headers.set(name, value);
    else dropped.push(name);
  }
  for (const [name, value] of Object.entries(target.headers)) headers.set(name, value);
  return { headers, dropped };
};

/** A model-routed request's endpoint and the body to send it, or why not (400, 413). Called once the handle is known. */
const routedRequest = async (request: Request): Promise<RoutedBody | { readonly status: number; readonly why: string }> => {
  const unnamed = { status: 400, why: "a model-routed request's JSON body names its model as <endpointId>/<modelId>" };
  if (request.method === "GET" || request.method === "HEAD") return unnamed;
  const read = await readCapped(request.body, declaredLength(request.headers));
  if ("tooLarge" in read) return { status: 413, why: `the body is over ${MAX_ROUTED_BODY_BYTES} bytes` };
  return routeBody(read.bytes) ?? unnamed;
};

/** One relayed request: the endpoint's answer streamed back, or the relay's own refusal. */
export const handleModelRelay = async (request: Request, deps: ModelRelayDeps): Promise<Response> => {
  const started = deps.now();
  const url = new URL(request.url);
  const match = PATH.exec(url.pathname);
  const routed = match?.[1] === MODEL_ROUTED_ID;
  // A routed request's endpoint is its body's, known once the body is read.
  let endpointId = match?.[1] !== undefined && ENDPOINT_ID.test(match[1]) ? match[1] : null;
  const rest = match?.[2] ?? "";
  const log = (status: number, grant: { readonly handleId: string | null; readonly workspace?: string | null; readonly cli?: string }, extra: Record<string, unknown> = {}) =>
    deps.log({
      t3flare: "model-relay",
      endpoint: endpointId,
      ...(routed ? { routed: true } : {}),
      status,
      handle: grant.handleId,
      ...(grant.cli === undefined ? {} : { cli: grant.cli }),
      workspace: grant.workspace ?? null,
      method: request.method,
      ms: deps.now() - started,
      ...extra,
    });
  if (endpointId === null && !routed) {
    log(404, { handleId: null }, { why: "not a model relay path" });
    return plain(404, "not a model relay path (/t3flare/model/<endpointId>/…)");
  }
  if (leavesBase(rest)) {
    log(400, { handleId: null }, { why: "a malformed escape, a dot segment, a separator or a control character" });
    return plain(400, "the path holds a malformed escape, an encoded dot segment, `/`, `\\` or a control character: it could leave the endpoint's base URL");
  }
  const handle = handleOf(request.headers);
  if (handle === null) {
    log(401, { handleId: null }, { why: "no model handle" });
    return plain(401, "the model relay needs this process's model handle as its key");
  }
  const ask = async (endpoint: string | null): Promise<ModelRelayGrant | Response> => {
    try {
      const grant = await deps.authorize({ handle, endpointId: endpoint });
      if (grant.kind !== "refused") return grant;
      log(grant.status, grant, { why: grant.message });
      return plain(grant.status, grant.message);
    } catch (error) {
      log(502, { handleId: null }, { why: `the Workspace did not answer (${error instanceof Error ? error.name : "error"})` });
      return plain(502, "the model relay could not check this handle");
    }
  };
  let routedBody: Uint8Array | undefined;
  let routedModel: string | null = null;
  if (endpointId === null) {
    // A model-routed request: the handle first, so an unknown one never has its body read; then the body's endpoint.
    const declared = declaredLength(request.headers);
    if (declared !== undefined && declared > MAX_ROUTED_BODY_BYTES) {
      log(413, { handleId: null }, { why: `the body is over ${MAX_ROUTED_BODY_BYTES} bytes` });
      return plain(413, `the body is over ${MAX_ROUTED_BODY_BYTES} bytes`);
    }
    const liveHandle = await ask(null);
    if (liveHandle instanceof Response) return liveHandle;
    const routedOrRefused = await routedRequest(request);
    if ("why" in routedOrRefused) {
      log(routedOrRefused.status, liveHandle, { why: routedOrRefused.why });
      return plain(routedOrRefused.status, routedOrRefused.why);
    }
    endpointId = routedOrRefused.endpointId;
    routedBody = routedOrRefused.body;
    routedModel = routedOrRefused.modelId;
  }
  const granted = await ask(endpointId);
  if (granted instanceof Response) return granted;
  // Asked with an endpoint, the Workspace DO grants or refuses: never only `known`.
  if (granted.kind !== "granted") {
    log(502, granted, { why: "the Workspace answered no target" });
    return plain(502, "the model relay could not check this handle");
  }
  const grant = granted;
  const target = new URL(`${grant.target.baseUrl}${rest}${url.search}`);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const { headers, dropped } = upstreamHeaders(request.headers, grant.target);
  // A routed body changed length with its model: its own length goes instead of the Container's.
  if (routedBody !== undefined) headers.delete("content-length");
  let upstream: Response;
  try {
    upstream = await deps.fetch(
      new Request(target, {
        method: request.method,
        headers,
        body: routedBody ?? (hasBody ? request.body : null),
        redirect: "manual",
        signal: request.signal,
        // Node's fetch needs this for a streamed body; workerd ignores it.
        ...({ duplex: "half" } as RequestInit),
      }),
    );
  } catch (error) {
    // The error may echo the request: only its name is logged.
    log(502, grant, { why: `unreachable (${error instanceof Error ? error.name : "error"})`, dropped });
    return plain(502, `the Model endpoint ${endpointId} could not be reached`);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    void upstream.body?.cancel().catch(() => undefined);
    log(502, grant, { why: `redirected (HTTP ${upstream.status})`, dropped });
    return plain(502, `the Model endpoint ${endpointId} redirected (HTTP ${upstream.status}); the relay follows no redirect: fix its base URL`);
  }
  const answer = new Headers();
  for (const [name, value] of upstream.headers) if (!DROPPED_RESPONSE.has(name)) answer.append(name, value);
  const endpoint = grant.target;
  const known = credentialValues(endpoint);
  const redact = (text: string) => redactSecrets(text, known);
  const classify = (status: number, body: string): DescribedFailure | undefined =>
    describeFailure({ status, headers: failureHeaders(upstream.headers), body, at: deps.now() }, { id: endpointId, api: endpoint.api, auth: endpoint.auth });
  const report = (failure: DescribedFailure | undefined): Promise<void> =>
    (deps.outcome?.(grant.handleId, failure === undefined ? null : { ...failure, endpointId, at: deps.now() }) ?? Promise.resolve()).catch(() => undefined);
  const logged = (failure: DescribedFailure | undefined) =>
    failure === undefined ? {} : { failure: { class: failure.class, code: failure.code, ...(failure.resetAt === undefined ? {} : { resetAt: failure.resetAt }) } };
  if (upstream.status < 400) {
    // The dropped headers' names (never values) show what a CLI sends that the allowlist keeps back.
    log(upstream.status, grant, { dropped });
    void report(undefined);
    const observed = observeUsage(upstream, { cli: grant.cli, endpointId, api: grant.target.api, modelId: routedModel, session: grant.handleId, at: started }, deps.usage);
    const streaming = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    // An error event inside the stream: redacted, classified, logged and reported as the process's last answer.
    const body =
      streaming && observed !== null
        ? observed.pipeThrough(
          sseErrors(redact, (event) => {
            const failure = classify(200, event);
            log(upstream.status, grant, { stream: "error-event", ...logged(failure) });
            void report(failure);
          }),
        )
      : observed;
    return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: answer });
  }
  // The error body, whole and redacted, so the CLI reads it as the vendor's; one over the cap is replaced, never cut.
  const read = await readBody(upstream, RELAY_ERROR_BODY_BYTES);
  void upstream.body?.cancel().catch(() => undefined);
  const text = read === undefined || read.over ? oversizedError(endpoint.api, upstream.status) : read.text;
  const failure = classify(upstream.status, text);
  log(upstream.status, grant, { dropped, ...logged(failure), ...(read?.over === true ? { oversized: true } : {}) });
  await report(failure);
  // The body's length (and any encoding) changed with the redaction.
  answer.delete("content-length");
  answer.delete("content-encoding");
  return new Response(redact(text), { status: upstream.status, statusText: upstream.statusText, headers: answer });
};

/** The values the endpoint's credential header carries (a bearer's token too), to redact wherever an answer echoes them. */
const credentialValues = (target: { readonly api: EndpointApi; readonly auth: "api-key" | "none"; readonly headers: Readonly<Record<string, string>> }): ReadonlyArray<string> => {
  if (target.auth === "none") return [];
  const name = credentialHeaderOf(target.api, "").name;
  return Object.entries(target.headers).flatMap(([header, value]) => {
    if (header.toLowerCase() !== name) return [];
    const bearer = /^Bearer\s+(\S+)$/i.exec(value)?.[1];
    return bearer === undefined ? [value] : [value, bearer];
  });
};

/** What `authorizeModelRelay` needs of the Workspace DO and the Environment. */
export interface AuthorizeDeps {
  readonly workspace: string | null;
  readonly destroyed: boolean;
  /** The live process a model handle was issued to, with the endpoints it is for (`ProcessHost.modelCaller`). */
  readonly caller: (handle: string | null) => (HandleCaller & { readonly endpoints: ReadonlySet<string> }) | null;
  /** The Environment DO's `modelRelayTarget`. */
  readonly target: (endpointId: string) => Promise<ModelRelayTarget>;
  /** The key the relay is about to use, for the sync guard (`EndpointKeyPatterns`). */
  readonly remember: (endpointId: string, key: string) => Promise<void>;
}

/**
 * The Workspace DO's check (`WorkspaceDO.modelRelay`): the handle names a live CLI process of this Workspace (another
 * Workspace's, a Tool handle, or one whose process exited is refused, 401) configured for this endpoint (403 otherwise);
 * then the Environment's target, whose key is remembered for the sync guard. With no endpoint, only the handle is
 * checked (`known`).
 */
export const authorizeModelRelay = async (input: ModelRelayAsk, deps: AuthorizeDeps): Promise<ModelRelayGrant> => {
  const { workspace } = deps;
  if (deps.destroyed) return { kind: "refused", status: 410, message: "this Workspace was deleted", handleId: null, workspace };
  const caller = deps.caller(input.handle);
  if (caller === null) return { kind: "refused", status: 401, message: "unknown or revoked model handle (a handle ends with its process)", handleId: null, workspace };
  if (input.endpointId === null) return { kind: "known", handleId: caller.key, cli: caller.cli, workspace };
  if (!caller.endpoints.has(input.endpointId)) {
    return { kind: "refused", status: 403, message: `this process's model handle is not for the Model endpoint ${input.endpointId}`, handleId: caller.key, workspace };
  }
  const target = await deps.target(input.endpointId);
  if (!target.ok) return { kind: "refused", status: target.status, message: target.message, handleId: caller.key, workspace };
  if (target.key !== null) await deps.remember(input.endpointId, target.key);
  return { kind: "granted", handleId: caller.key, cli: caller.cli, workspace, target: { api: target.api, auth: target.auth, baseUrl: target.baseUrl, headers: target.headers } };
};
