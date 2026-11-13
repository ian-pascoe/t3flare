// Adapted from cloudpid@93ba45a3:packages/extensions/src/web/{transport,errors,response,dns,guarded-fetch}.ts (SPI-1054;
// see ./NOTICE.md): the web tools' network, the SSRF guard and bounded reads, as plain Promise code instead of Effect
// services. The rules are cloudpid's: every hop (the URL the model gave and each redirect target) is checked by
// `ssrf.ts` and its host resolved through Cloudflare's DNS-over-HTTPS before a request is sent; redirects are followed
// by hand; a body is read incrementally and never past its bound.
//
// The residual risk is cloudpid's too: the platform's own lookup at `fetch` time is separate from the guard's, so a
// name that answers differently to two queries milliseconds apart can still pass. Both go through Cloudflare's caching
// resolver, and Cloudflare's edge refuses Worker subrequests to private addresses anyway.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off extendsNativeError:off globalTimers:off
import { blockedAddressReason, blockedHostReason } from "./ssrf.ts";

/** A web tool could not do what it was asked: the model sees `message` as the tool's error result. */
export class WebToolError extends Error {
  override readonly name = "WebToolError";
}

/** One HTTP request. Redirects are never followed by the transport: the caller sees the 3xx and decides. */
export interface WebRequest {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The network, as the web tools see it: a test answers requests without one. Resolves for any status, body unread. */
export type WebTransport = (request: WebRequest, signal: AbortSignal | undefined) => Promise<Response>;

/** Workers' `fetch`, with redirects left to the caller. */
export const workerTransport: WebTransport = (request, signal) =>
  fetch(request.url, {
    method: request.method ?? "GET",
    headers: request.headers,
    body: request.body ?? null,
    redirect: "manual",
    ...(signal === undefined ? {} : { signal }),
  }).catch(() => {
    throw new WebToolError(signal?.aborted === true ? "aborted" : "network error");
  });

const STATUS_PHRASES: ReadonlyMap<number, string> = new Map([
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [402, "Payment Required"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [405, "Method Not Allowed"],
  [406, "Not Acceptable"],
  [408, "Request Timeout"],
  [409, "Conflict"],
  [410, "Gone"],
  [415, "Unsupported Media Type"],
  [418, "I'm a Teapot"],
  [429, "Too Many Requests"],
  [451, "Unavailable For Legal Reasons"],
  [500, "Internal Server Error"],
  [501, "Not Implemented"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
  [504, "Gateway Timeout"],
]);

/** The cause of a response that is not a success: its status and the standard phrase, never server-supplied text. */
export const statusCause = (status: number): string => {
  const phrase = STATUS_PHRASES.get(status);
  return phrase === undefined ? `HTTP ${status}` : `HTTP ${status} ${phrase}`;
};

/** Drop a response's body without reading it. */
export const discardBody = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};

const formatByteLimit = (bytes: number): string => (bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes}-byte`);

/**
 * Read a response's body incrementally, never holding more than `maximumBytes`: a larger declared or streamed body
 * fails and the rest is cancelled.
 */
export const readBoundedBody = async (response: Response, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array> => {
  const tooLarge = () => new WebToolError(`response body exceeds the ${formatByteLimit(maximumBytes)} limit`);
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isSafeInteger(declared) && declared > maximumBytes) {
    await discardBody(response);
    throw tooLarge();
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  const abort = (): void => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        // oxlint-disable-next-line no-await-in-loop -- chunks arrive in order
        chunk = await reader.read();
      } catch {
        throw new WebToolError("network error while reading the response body");
      }
      if (chunk.done) break;
      if (total + chunk.value.byteLength > maximumBytes) {
        // oxlint-disable-next-line no-await-in-loop -- once, then out
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(chunk.value);
      total += chunk.value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** Cloudflare's DNS-over-HTTPS JSON endpoint. */
export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

const RECORD_TYPE = { A: 1, AAAA: 28 } as const;
const NXDOMAIN = 3;

/**
 * The addresses `hostname` resolves to (A and AAAA), through `transport`. Fails closed: a lookup that cannot be made or
 * understood refuses, as does a name with no address records.
 */
export const resolveHost = async (transport: WebTransport, hostname: string, signal?: AbortSignal): Promise<ReadonlyArray<string>> => {
  const unresolvable = () => new WebToolError("could not verify where the host resolves (DNS lookup failed)");
  const query = async (type: "A" | "AAAA"): Promise<ReadonlyArray<string>> => {
    const response = await transport({ url: `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`, headers: { accept: "application/dns-json" } }, signal);
    if (!response.ok) {
      await discardBody(response);
      throw unresolvable();
    }
    let answer: { Status?: unknown; Answer?: unknown };
    try {
      answer = JSON.parse(await response.text()) as typeof answer;
    } catch {
      throw unresolvable();
    }
    if (answer.Status === NXDOMAIN) throw new WebToolError("host not found");
    if (answer.Status !== 0) throw unresolvable();
    const records = Array.isArray(answer.Answer) ? (answer.Answer as ReadonlyArray<{ type?: unknown; data?: unknown }>) : [];
    return records.flatMap((record) => (record.type === RECORD_TYPE[type] && typeof record.data === "string" ? [record.data] : []));
  };
  const [v4, v6] = await Promise.all([query("A"), query("AAAA")]);
  const addresses = [...v4, ...v6];
  if (addresses.length === 0) throw new WebToolError("host has no address records");
  return addresses;
};

/** Most redirects one fetch follows. */
export const MAX_REDIRECTS = 10;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** An IPv4 literal or a bracketed IPv6 literal needs no lookup: the host rules already judged the address. */
const isLiteralAddress = (hostname: string): boolean => hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);

/**
 * Check that `url` may be fetched: an HTTP(S) URL without credentials, whose host is neither a private name nor address
 * nor resolves to one. `hop` is 0 for the URL the model gave and above for a redirect's target.
 */
const checkUrl = async (transport: WebTransport, url: URL, hop: number, signal?: AbortSignal): Promise<void> => {
  const blocked = (reason: string) => new WebToolError(hop === 0 ? `blocked: ${reason}` : `redirect blocked: ${reason}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebToolError(`unsupported URL scheme ${url.protocol} (Web Fetch requires an HTTP or HTTPS URL)`);
  }
  if (url.username !== "" || url.password !== "") throw new WebToolError("URLs with credentials are not supported");
  const reason = blockedHostReason(url.hostname);
  if (reason !== undefined) throw blocked(reason);
  if (isLiteralAddress(url.hostname)) return;
  const addresses = await resolveHost(transport, url.hostname.replace(/\.+$/, ""), signal);
  const unsafe = addresses.find((address) => blockedAddressReason(address) !== undefined);
  if (unsafe !== undefined) throw blocked(`host resolves to a ${blockedAddressReason(unsafe) ?? "non-public address"}`);
};

/**
 * Send `request`, following redirects by hand (up to `MAX_REDIRECTS`) and checking the URL and every redirect target
 * first. Returns the first response that is not a redirect, with the URL it came from. A refused target fails with
 * `blocked: …` and nothing is sent to it.
 */
export const guardedFetch = async (
  transport: WebTransport,
  request: WebRequest,
  signal?: AbortSignal,
): Promise<{ readonly response: Response; readonly url: URL }> => {
  let current: URL;
  try {
    current = new URL(request.url);
  } catch {
    throw new WebToolError("invalid URL (expected an absolute HTTP or HTTPS URL)");
  }
  for (let hop = 0; ; hop++) {
    // oxlint-disable-next-line no-await-in-loop -- each hop is checked before it is sent
    await checkUrl(transport, current, hop, signal);
    // oxlint-disable-next-line no-await-in-loop -- one hop at a time
    const response = await transport({ ...request, url: current.toString() }, signal);
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return { response, url: current };
    // The redirect's body is never read.
    // oxlint-disable-next-line no-await-in-loop -- one hop at a time
    await discardBody(response);
    if (hop >= MAX_REDIRECTS) throw new WebToolError(`too many redirects (more than ${MAX_REDIRECTS})`);
    try {
      current = new URL(location, current);
    } catch {
      throw new WebToolError("redirected to an invalid URL");
    }
  }
};

/** `run` with a deadline of `ms`: aborts `signal`'s child and fails with `timed out after …`. */
export const withDeadline = async <T>(ms: number, label: string, outer: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  const onAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onAbort, { once: true });
  if (outer?.aborted === true) controller.abort(outer.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new WebToolError(`timed out after ${label}`));
      reject(new WebToolError(`timed out after ${label}`));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
};
