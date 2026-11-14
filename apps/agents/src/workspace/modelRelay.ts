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
import { ENDPOINT_ID, type EndpointApi } from "@t3flare/models/endpoints";
import { forwardedHeadersOf, KEY_HEADERS, MODEL_RELAY_PREFIX, type ModelRelayTarget } from "@t3flare/models/relay";
import { HANDLE } from "@t3flare/workspace-client";

/** What the Workspace DO answers for a handle and an endpoint. */
export type ModelRelayGrant =
  | {
      readonly kind: "granted";
      /** The handle's id for the logs: the key of the process it was issued to. */
      readonly handleId: string;
      readonly cli: string;
      readonly workspace: string | null;
      readonly target: { readonly api: EndpointApi; readonly baseUrl: string; readonly headers: Readonly<Record<string, string>> };
    }
  | { readonly kind: "refused"; readonly status: number; readonly message: string; readonly handleId: string | null; readonly workspace: string | null };

export interface ModelRelayDeps {
  /** The Workspace DO's `modelRelay`: the handle's process, and the endpoint's target from the Environment. */
  readonly authorize: (input: { readonly handle: string | null; readonly endpointId: string }) => Promise<ModelRelayGrant>;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly log: (event: Record<string, unknown>) => void;
  readonly now: () => number;
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

/** A segment decoded as an upstream might, up to three times (a double-encoded dot is still a dot). */
const decodedSegment = (segment: string): string => {
  let decoded = segment;
  for (let round = 0; round < 3; round++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return decoded;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
};

/**
 * Whether the path below the endpoint's id could leave its base URL at an upstream that decodes it: a dot segment, or a
 * `/` or `\` in a segment, in any encoding. `URL` has already resolved literal and singly encoded dot segments, and
 * turned a literal `\` into `/`.
 */
const leavesBase = (rest: string): boolean =>
  rest
    .split("/")
    .slice(1)
    .some((segment) => {
      const decoded = decodedSegment(segment);
      return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
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

/** One relayed request: the endpoint's answer streamed back, or the relay's own refusal. */
export const handleModelRelay = async (request: Request, deps: ModelRelayDeps): Promise<Response> => {
  const started = deps.now();
  const url = new URL(request.url);
  const match = PATH.exec(url.pathname);
  const endpointId = match?.[1] !== undefined && ENDPOINT_ID.test(match[1]) ? match[1] : null;
  const rest = match?.[2] ?? "";
  const log = (status: number, grant: { readonly handleId: string | null; readonly workspace?: string | null; readonly cli?: string }, extra: Record<string, unknown> = {}) =>
    deps.log({
      t3flare: "model-relay",
      endpoint: endpointId,
      status,
      handle: grant.handleId,
      ...(grant.cli === undefined ? {} : { cli: grant.cli }),
      workspace: grant.workspace ?? null,
      method: request.method,
      ms: deps.now() - started,
      ...extra,
    });
  if (endpointId === null) {
    log(404, { handleId: null }, { why: "not a model relay path" });
    return plain(404, "not a model relay path (/t3flare/model/<endpointId>/…)");
  }
  if (leavesBase(rest)) {
    log(400, { handleId: null }, { why: "an encoded dot segment or separator" });
    return plain(400, "the path holds an encoded dot segment, `/` or `\\`: it could leave the endpoint's base URL");
  }
  const handle = handleOf(request.headers);
  if (handle === null) {
    log(401, { handleId: null }, { why: "no model handle" });
    return plain(401, "the model relay needs this process's model handle as its key");
  }
  let grant: ModelRelayGrant;
  try {
    grant = await deps.authorize({ handle, endpointId });
  } catch (error) {
    log(502, { handleId: null }, { why: `the Workspace did not answer (${error instanceof Error ? error.name : "error"})` });
    return plain(502, "the model relay could not check this handle");
  }
  if (grant.kind === "refused") {
    log(grant.status, grant, { why: grant.message });
    return plain(grant.status, grant.message);
  }
  const target = new URL(`${grant.target.baseUrl}${rest}${url.search}`);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const { headers, dropped } = upstreamHeaders(request.headers, grant.target);
  let upstream: Response;
  try {
    upstream = await deps.fetch(
      new Request(target, {
        method: request.method,
        headers,
        body: hasBody ? request.body : null,
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
  // The dropped headers' names (never values) show what a CLI sends that the allowlist keeps back.
  log(upstream.status, grant, { dropped });
  const answer = new Headers();
  for (const [name, value] of upstream.headers) if (!DROPPED_RESPONSE.has(name)) answer.append(name, value);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: answer });
};

/** What `authorizeModelRelay` needs of the Workspace DO and the Environment. */
export interface AuthorizeDeps {
  readonly workspace: string | null;
  readonly destroyed: boolean;
  /** The live process a model handle was issued to, with the endpoints it is for (`ProcessHost.modelCaller`). */
  readonly caller: (handle: string | null) => { readonly key: string; readonly cli: string; readonly endpoints: ReadonlySet<string> } | null;
  /** The Environment DO's `modelRelayTarget`. */
  readonly target: (endpointId: string) => Promise<ModelRelayTarget>;
  /** The key the relay is about to use, for the sync guard (`EndpointKeyPatterns`). */
  readonly remember: (endpointId: string, key: string) => Promise<void>;
}

/**
 * The Workspace DO's check (`WorkspaceDO.modelRelay`): the handle names a live CLI process of this Workspace (another
 * Workspace's, a Tool handle, or one whose process exited is refused, 401) configured for this endpoint (403 otherwise);
 * then the Environment's target, whose key is remembered for the sync guard.
 */
export const authorizeModelRelay = async (input: { readonly handle: string | null; readonly endpointId: string }, deps: AuthorizeDeps): Promise<ModelRelayGrant> => {
  const { workspace } = deps;
  if (deps.destroyed) return { kind: "refused", status: 410, message: "this Workspace was deleted", handleId: null, workspace };
  const caller = deps.caller(input.handle);
  if (caller === null) return { kind: "refused", status: 401, message: "unknown or revoked model handle (a handle ends with its process)", handleId: null, workspace };
  if (!caller.endpoints.has(input.endpointId)) {
    return { kind: "refused", status: 403, message: `this process's model handle is not for the Model endpoint ${input.endpointId}`, handleId: caller.key, workspace };
  }
  const target = await deps.target(input.endpointId);
  if (!target.ok) return { kind: "refused", status: target.status, message: target.message, handleId: caller.key, workspace };
  if (target.key !== null) await deps.remember(input.endpointId, target.key);
  return { kind: "granted", handleId: caller.key, cli: caller.cli, workspace, target: { api: target.api, baseUrl: target.baseUrl, headers: target.headers } };
};
