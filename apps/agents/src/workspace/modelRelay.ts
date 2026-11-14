// The model relay (SPI-1167; ADR-0016's model relay refinement), in `WorkspaceProxy`: a CLI agent in the Container sends
// its model requests to `computer.internal/t3flare/model/<endpointId>/…` with its model handle as its key. This route
// takes the handle out, asks the Workspace DO whether it names a live process here and, if so, for the endpoint's target
// (the Environment's `resolve`: base URL, headers, credential), and sends the request there: the path below the
// endpoint's id appended to its base URL, the body and the answer streamed through unchanged, no protocol translation.
// Only the endpoint's own credential goes out; the handle never does. Redirects are not followed. Every request is
// logged with its endpoint, status and the handle's id (its process's key), never a value. Pure, deps injected; a CLI
// adds only its own config.
import { ENDPOINT_ID } from "@t3flare/models/endpoints";
import { MODEL_HANDLE, MODEL_RELAY_PREFIX } from "@t3flare/models/relay";

/** What the Workspace DO answers for a handle and an endpoint. */
export type ModelRelayGrant =
  | {
      readonly kind: "granted";
      /** The handle's id for the logs: the key of the process it was issued to. */
      readonly handleId: string;
      readonly cli: string;
      readonly workspace: string | null;
      readonly target: { readonly baseUrl: string; readonly headers: Readonly<Record<string, string>> };
    }
  | { readonly kind: "refused"; readonly status: number; readonly message: string; readonly handleId: string | null; readonly workspace: string | null };

export interface ModelRelayDeps {
  /** The Workspace DO's `modelRelay`: the handle's process, and the endpoint's target from the Environment. */
  readonly authorize: (input: { readonly handle: string | null; readonly endpointId: string }) => Promise<ModelRelayGrant>;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly log: (event: Record<string, unknown>) => void;
  readonly now: () => number;
}

/** Where a handle may come: a bearer (OpenAI-shaped APIs) or the key headers of Anthropic's and Google's APIs. */
const HANDLE_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "api-key"];

/** Request headers never passed on: the handle's, hop-by-hop ones, and the platform's and the Container's own. */
const DROPPED_REQUEST = new Set([
  ...HANDLE_HEADERS,
  "proxy-authorization",
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-real-ip",
]);
const DROPPED_REQUEST_PREFIXES = ["cf-", "x-forwarded-", "x-t3flare-"];

/** Response headers not passed back: hop-by-hop ones and cookies. */
const DROPPED_RESPONSE = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "set-cookie"]);

const PATH = new RegExp(`^${MODEL_RELAY_PREFIX.replaceAll("/", "\\/")}([^/]+)(\\/.*)?$`);

export const isModelRelayPath = (pathname: string): boolean => pathname.startsWith(MODEL_RELAY_PREFIX);

const plain = (status: number, message: string): Response =>
  new Response(`t3flare: ${message}\n`, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } });

const handleOf = (headers: Headers): string | null => {
  for (const name of HANDLE_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value === undefined || value === "") continue;
    const word = name === "authorization" ? /^Bearer\s+(\S+)$/i.exec(value)?.[1] : value;
    return word !== undefined && MODEL_HANDLE.test(word) ? word : null;
  }
  return null;
};

/** The endpoint's URL for `rest` (the path below the endpoint's id) and `search`, or null when it would leave the base URL. */
const upstreamUrl = (baseUrl: string, rest: string, search: string): URL | null => {
  const base = new URL(baseUrl);
  const url = new URL(`${baseUrl}${rest}${search}`);
  const prefix = base.pathname.replace(/\/+$/, "");
  if (url.origin !== base.origin || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) return null;
  return url;
};

const upstreamHeaders = (incoming: Headers, endpoint: Readonly<Record<string, string>>): Headers => {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (DROPPED_REQUEST.has(name) || DROPPED_REQUEST_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    headers.set(name, value);
  }
  // The endpoint's headers, then its credential, win over anything the CLI sent.
  for (const [name, value] of Object.entries(endpoint)) headers.set(name, value);
  return headers;
};

/** One relayed request: the endpoint's answer streamed back, or the relay's own refusal. */
export const handleModelRelay = async (request: Request, deps: ModelRelayDeps): Promise<Response> => {
  const started = deps.now();
  const url = new URL(request.url);
  const match = PATH.exec(url.pathname);
  const endpointId = match?.[1];
  if (match === null || endpointId === undefined || !ENDPOINT_ID.test(endpointId)) return plain(404, "not a model relay path (/t3flare/model/<endpointId>/…)");
  const rest = match[2] ?? "";
  const log = (status: number, grant: { readonly handleId: string | null; readonly workspace?: string | null; readonly cli?: string }, why?: string) =>
    deps.log({
      t3flare: "model-relay",
      endpoint: endpointId,
      status,
      handle: grant.handleId,
      ...(grant.cli === undefined ? {} : { cli: grant.cli }),
      workspace: grant.workspace ?? null,
      method: request.method,
      ms: deps.now() - started,
      ...(why === undefined ? {} : { why }),
    });
  const handle = handleOf(request.headers);
  if (handle === null) {
    log(401, { handleId: null }, "no model handle");
    return plain(401, "the model relay needs this process's model handle as its key");
  }
  const grant = await deps.authorize({ handle, endpointId });
  if (grant.kind === "refused") {
    log(grant.status, grant, grant.message);
    return plain(grant.status, grant.message);
  }
  const target = upstreamUrl(grant.target.baseUrl, rest, url.search);
  if (target === null) {
    log(404, grant, "outside the endpoint's base URL");
    return plain(404, "the path leaves the endpoint's base URL");
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await deps.fetch(
      new Request(target, {
        method: request.method,
        headers: upstreamHeaders(request.headers, grant.target.headers),
        body: hasBody ? request.body : null,
        redirect: "manual",
        signal: request.signal,
        // Node's fetch needs this for a streamed body; workerd ignores it.
        ...({ duplex: "half" } as RequestInit),
      }),
    );
  } catch (error) {
    // The error may echo the request: only its name is logged.
    log(502, grant, `unreachable (${error instanceof Error ? error.name : "error"})`);
    return plain(502, `the Model endpoint ${endpointId} could not be reached`);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    void upstream.body?.cancel().catch(() => undefined);
    log(502, grant, `redirected (HTTP ${upstream.status})`);
    return plain(502, `the Model endpoint ${endpointId} redirected (HTTP ${upstream.status}); the relay follows no redirect: fix its base URL`);
  }
  log(upstream.status, grant);
  const headers = new Headers();
  for (const [name, value] of upstream.headers) if (!DROPPED_RESPONSE.has(name)) headers.append(name, value);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
};
