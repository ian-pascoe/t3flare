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
import { ENDPOINT_ID, isSignIn } from "@t3flare/models/endpoints";
import { describeFailure, type DescribedFailure, failureHeaders, readBody } from "@t3flare/models/failures";
import { redactSecrets } from "@t3flare/models/redact";
import type { EndpointFailureRecord } from "@t3flare/session-protocol";
import { credentialHeaderFor, forwardedHeadersOf, KEY_HEADERS, MODEL_RELAY_PREFIX, MODEL_ROUTED_ID, type ModelRelayTarget, type RelaySignInRefusal, type RelayTarget } from "@t3flare/models/relay";
import { HANDLE } from "@t3flare/workspace-client";

import type { HandleCaller } from "./processHost.ts";
import { oversizedError, RELAY_ERROR_BODY_BYTES, sseErrors } from "./relayFailures.ts";
import { declaredLength, MAX_ROUTED_BODY_BYTES, readCapped, type RoutedBody, routeBody } from "./routedBody.ts";
import { signInBody, signInPathRefusal, signInRefusal, signInRequest, tokenLogHashPrefix } from "./relaySignIns.ts";
import { observeUsage } from "./relayUsage.ts";
import type { UsageEntry } from "@t3flare/models/usage";
import { type LimitReading, limitReadingOf } from "@t3flare/models/limits";

export { MAX_ROUTED_BODY_BYTES } from "./routedBody.ts";

/** What the Workspace DO answers for a handle and an endpoint. */
export type ModelRelayGrant =
  | {
      readonly kind: "granted";
      /** The handle's id for the logs: the key of the process it was issued to. */
      readonly handleId: string;
      readonly cli: string;
      readonly workspace: string | null;
      readonly target: RelayTarget;
    }
  /** The handle names a live process here (asked with no endpoint: a model-routed request before its body is read). */
  | { readonly kind: "known"; readonly handleId: string; readonly cli: string; readonly workspace: string | null }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly message: string;
      readonly handleId: string | null;
      readonly workspace: string | null;
      /** A sign-in that gave no token now (SPI-1171): the relay answers naming it, in the API's shape. */
      readonly signIn?: RelaySignInRefusal;
    };

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
   * SPI-1174: the limit windows each endpoint answer's headers report (a failed answer's too), for t3's limit meters.
   * Read as the answer's headers arrive, before the CLI has it; never in its way.
   */
  readonly limits?: (reading: LimitReading) => void;
  /**
   * SPI-1172: the process's last answer, for the Workspace DO: its classified failure, or null for a success or an error
   * the table does not know (the last answer always wins). Never fails the request.
   */
  readonly outcome?: (handleId: string, failure: EndpointFailureRecord | null) => Promise<void>;
}

/** What `WorkspaceProxy` reaches of the Workspace DO for the relay (its RPC stub's methods answer promises). */
export interface WorkspaceRelayRpc {
  modelRelay(input: ModelRelayAsk): Promise<ModelRelayGrant>;
  modelRelayOutcome(input: { readonly handleId: string; readonly failure: EndpointFailureRecord | null }): Promise<void> | void;
}

/** The relay's deps in `WorkspaceProxy`: the Workspace DO's check, and each answer reported to it before the CLI has it. */
export const workspaceRelayDeps = (rpc: WorkspaceRelayRpc, io: Pick<ModelRelayDeps, "fetch" | "log" | "now" | "usage"> & Required<Pick<ModelRelayDeps, "limits">>): ModelRelayDeps => ({
  ...io,
  authorize: (input) => rpc.modelRelay(input),
  outcome: async (handleId, failure) => {
    await rpc.modelRelayOutcome({ handleId, failure });
  },
});

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
const upstreamHeaders = (incoming: Headers, target: Pick<RelayTarget, "api" | "headers">): { readonly headers: Headers; readonly dropped: ReadonlyArray<string> } => {
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
      if (grant.signIn !== undefined && grant.handleId !== null && endpoint !== null) {
        // SPI-1171: the sign-in gave no token; the CLI and t3 are told which, and why.
        const refused = signInRefusal(endpoint, grant.signIn, deps.now());
        log(refused.response.status, grant, { why: grant.message, signIn: grant.signIn.kind, failure: { class: refused.failure.class, code: refused.failure.code } });
        await (deps.outcome?.(grant.handleId, { ...refused.failure, endpointId: endpoint, at: deps.now() }) ?? Promise.resolve()).catch(() => undefined);
        return refused.response;
      }
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
  let body: Uint8Array | ReadableStream<Uint8Array> | null = routedBody ?? (hasBody ? request.body : null);
  if (isSignIn(grant.target.auth)) {
    // SPI-1171: only the sign-in's inference paths, before anything is sent; then its request rules (`relaySignIns.ts`).
    const offPath = signInPathRefusal(grant.target.auth, request.method, rest);
    if (offPath !== undefined) {
      log(offPath.status, grant, { why: offPath.why });
      return plain(offPath.status, offPath.why);
    }
    const read = await signInBody(request, routedBody);
    if ("why" in read) {
      log(read.status, grant, { why: read.why });
      return plain(read.status, read.why);
    }
    const shaped = signInRequest(grant.target.auth, read.bytes, request.headers);
    for (const [name, value] of Object.entries(shaped.headers)) headers.set(name, value);
    if (shaped.changed) headers.delete("content-length");
    body = shaped.body ?? null;
  }
  // SPI-1172: each answer goes to the Workspace DO before the CLI sees it (`RelayFailures` keeps the turn's most telling one).
  const report = (failure: DescribedFailure | undefined): Promise<void> =>
    (deps.outcome?.(grant.handleId, failure === undefined ? null : { ...failure, endpointId, at: deps.now() }) ?? Promise.resolve()).catch(() => undefined);
  let upstream: Response;
  try {
    upstream = await deps.fetch(
      new Request(target, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal: request.signal,
        // Node's fetch needs this for a streamed body; workerd ignores it.
        ...({ duplex: "half" } as RequestInit),
      }),
    );
  } catch (error) {
    // The error may echo the request: only its name is logged.
    log(502, grant, { why: `unreachable (${error instanceof Error ? error.name : "error"})`, dropped });
    // The relay's own failure, no endpoint's answer: a passing failure recorded before it is no longer the latest.
    await report(undefined);
    return plain(502, `the Model endpoint ${endpointId} could not be reached`);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    void upstream.body?.cancel().catch(() => undefined);
    log(502, grant, { why: `redirected (HTTP ${upstream.status})`, dropped });
    await report(undefined);
    return plain(502, `the Model endpoint ${endpointId} redirected (HTTP ${upstream.status}); the relay follows no redirect: fix its base URL`);
  }
  // SPI-1174: the endpoint's limit windows, as this answer's headers report them (a refused limit's too).
  noteLimits(endpointId, upstream.headers, deps);
  const answer = new Headers();
  for (const [name, value] of upstream.headers) if (!DROPPED_RESPONSE.has(name)) answer.append(name, value);
  const endpoint = grant.target;
  const known = credentialValues(endpoint);
  const redact = (text: string) => redactSecrets(text, known);
  // SPI-1171: which of a sign-in's tokens went (a short hash, never the token), so a mid-thread renewal shows in the log.
  // `credentialValues` gives a bearer's header value, then its token: the token is the last.
  const bearerToken = known.at(-1);
  const signedWith = isSignIn(endpoint.auth) && bearerToken !== undefined ? { signIn: endpoint.auth, credential: await tokenLogHashPrefix(bearerToken) } : {};
  const classify = (status: number, body: string): DescribedFailure | undefined =>
    describeFailure({ status, headers: failureHeaders(upstream.headers), body, at: deps.now() }, { id: endpointId, api: endpoint.api, auth: endpoint.auth });
  const logged = (failure: DescribedFailure | undefined) =>
    failure === undefined ? {} : { failure: { class: failure.class, code: failure.code, ...(failure.resetAt === undefined ? {} : { resetAt: failure.resetAt }) } };
  if (upstream.status < 400) {
    // The dropped headers' names (never values) show what a CLI sends that the allowlist keeps back.
    log(upstream.status, grant, { dropped, ...signedWith });
    await report(undefined);
    const observed = observeUsage(upstream, { cli: grant.cli, endpointId, api: grant.target.api, modelId: routedModel, session: grant.handleId, at: started }, deps.usage);
    const streaming = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    // An error event inside the stream: redacted, classified, logged and reported as the process's last answer.
    const body =
      streaming && observed !== null
        ? observed.pipeThrough(
          sseErrors(redact, async (event) => {
            const failure = classify(event.status ?? 200, event.body);
            log(upstream.status, grant, { stream: "error-event", ...logged(failure) });
            await report(failure);
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
  log(upstream.status, grant, { dropped, ...signedWith, ...logged(failure), ...(read?.over === true ? { oversized: true } : {}) });
  await report(failure);
  // The body's length (and any encoding) changed with the redaction.
  answer.delete("content-length");
  answer.delete("content-encoding");
  return new Response(redact(text), { status: upstream.status, statusText: upstream.statusText, headers: answer });
};

/** The reading of an answer's limit headers to `deps.limits`; a reading that fails is lost, never the answer. */
const noteLimits = (endpointId: string, headers: Headers, deps: Pick<ModelRelayDeps, "limits" | "now">): void => {
  if (deps.limits === undefined) return;
  try {
    const reading = limitReadingOf(endpointId, headers, deps.now());
    if (reading !== undefined) deps.limits(reading);
  } catch {
    // Lost; the answer goes on.
  }
};

/** The values the endpoint's credential header carries (a bearer's token too), to redact wherever an answer echoes them. */
const credentialValues = (target: RelayTarget): ReadonlyArray<string> => {
  if (target.auth === "none") return [];
  // A sign-in's token is a bearer on every API (SPI-1171).
  const name = credentialHeaderFor(target.api, target.auth, "").name;
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
  if (!target.ok) return { kind: "refused", status: target.status, message: target.message, handleId: caller.key, workspace, ...(target.signIn === undefined ? {} : { signIn: target.signIn }) };
  if (target.key !== null) await deps.remember(input.endpointId, target.key);
  return { kind: "granted", handleId: caller.key, cli: caller.cli, workspace, target: { api: target.api, auth: target.auth, baseUrl: target.baseUrl, headers: target.headers } };
};
