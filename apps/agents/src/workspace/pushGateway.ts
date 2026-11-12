// The push gateway's protocol half (SPI-992, review M1): what a Container's `git push` asks GitHub to do, read from the
// receive-pack request with a strict pkt-line grammar, and the bytes the gateway sends GitHub instead, re-serialised
// from what it parsed, so GitHub never reads a byte the policy did not. Shapes from probe P4 (git 2.56): no
// Content-Encoding on receive-pack, a `0000` probe before a chunked push, push options in their own section.

/** One ref update: GitHub sets `ref` from `old` to `new` (all zeros: create when old, delete when new). */
export interface RefUpdate {
  readonly old: string;
  readonly new: string;
  readonly ref: string;
}

export type ParsedCommands =
  | { readonly kind: "probe" }
  | { readonly kind: "incomplete" }
  | { readonly kind: "refuse"; readonly reason: string }
  | {
      readonly kind: "commands";
      readonly updates: ReadonlyArray<RefUpdate>;
      readonly shallow: ReadonlyArray<string>;
      readonly capabilities: ReadonlyArray<string>;
      readonly pushOptions: ReadonlyArray<string>;
      /** How many bytes of the request the command list (and push options) took: the pack follows. */
      readonly consumed: number;
    };

/** The most bytes the command list and push options may take (review M1's cap). */
export const MAX_PREFIX_BYTES = 64 * 1024;
/** The most ref updates one request may carry. */
export const MAX_UPDATES = 64;
const MAX_PUSH_OPTIONS = 32;

/** The capabilities a client may ask for; anything else is refused, so nothing GitHub would act on passes unread. */
const CAPABILITIES = new Set(["report-status", "report-status-v2", "side-band", "side-band-64k", "quiet", "atomic", "ofs-delta", "push-options"]);
const VALUED_CAPABILITIES = ["agent=", "object-format=", "session-id="];

/** Whether `ref` is a ref name `git check-ref-format` accepts, under `refs/` with at least two more components. */
export const isValidRefName = (ref: string): boolean => {
  if (!ref.startsWith("refs/") || ref.split("/").length < 3) return false;
  if (ref.endsWith("/") || ref.endsWith(".") || ref.includes("//") || ref.includes("..") || ref.includes("@{") || ref === "@") return false;
  for (const char of ref) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || " ~^:?*[\\".includes(char)) return false;
  }
  return ref.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
};

const HEX4 = /^[0-9a-f]{4}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The pkt-lines of `bytes` up to `flushes` flushes: null lines are flushes; `incomplete` when the bytes end first. */
const readPackets = (bytes: Uint8Array, flushes: number, from: number): { readonly lines: ReadonlyArray<string | null>; readonly end: number } | "incomplete" | { readonly refuse: string } => {
  const lines: Array<string | null> = [];
  let at = from;
  let left = flushes;
  while (left > 0) {
    if (at > MAX_PREFIX_BYTES) return { refuse: "the push's command list is too large" };
    if (at + 4 > bytes.length) return "incomplete";
    const head = String.fromCharCode(...bytes.subarray(at, at + 4));
    if (!HEX4.test(head)) return { refuse: "malformed pkt-line length" };
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      lines.push(null);
      at += 4;
      left -= 1;
      continue;
    }
    if (length < 5) return { refuse: "malformed pkt-line length" };
    if (at + length > MAX_PREFIX_BYTES) return { refuse: "the push's command list is too large" };
    if (at + length > bytes.length) return "incomplete";
    let line: string;
    try {
      line = decoder.decode(bytes.subarray(at + 4, at + length));
    } catch {
      return { refuse: "a pkt-line is not UTF-8" };
    }
    lines.push(line.endsWith("\n") ? line.slice(0, -1) : line);
    at += length;
  }
  return { lines, end: at };
};

/** Reads the receive-pack request's command list (and push options) from the request's first bytes. */
export const parseCommands = (bytes: Uint8Array): ParsedCommands => {
  const first = readPackets(bytes, 1, 0);
  if (first === "incomplete") return { kind: "incomplete" };
  if ("refuse" in first) return { kind: "refuse", reason: first.refuse };
  const lines = first.lines.slice(0, -1) as ReadonlyArray<string>;
  if (lines.length === 0) return first.end === bytes.length ? { kind: "probe" } : { kind: "refuse", reason: "bytes after an empty command list" };
  const shallow: Array<string> = [];
  const updates: Array<RefUpdate> = [];
  let capabilities: ReadonlyArray<string> | undefined;
  for (const raw of lines) {
    let line = raw;
    if (capabilities === undefined) {
      if (line.startsWith("shallow ")) {
        const oid = line.slice(8);
        if (!OID.test(oid)) return { kind: "refuse", reason: "malformed shallow line" };
        shallow.push(oid);
        continue;
      }
      const nul = line.indexOf("\0");
      if (nul < 0) return { kind: "refuse", reason: "the first command carries no capabilities" };
      capabilities = line.slice(nul + 1).split(" ").filter((cap) => cap !== "");
      line = line.slice(0, nul);
    } else if (line.includes("\0")) return { kind: "refuse", reason: "a NUL after the first command" };
    if (line.startsWith("push-cert")) return { kind: "refuse", reason: "push certificates (signed pushes) are not supported" };
    const parts = line.split(" ");
    if (parts.length !== 3) return { kind: "refuse", reason: "malformed command" };
    const [old, next, ref] = parts as [string, string, string];
    if (!OID.test(old) || !OID.test(next) || old.length !== next.length) return { kind: "refuse", reason: "malformed object id" };
    if (!isValidRefName(ref)) return { kind: "refuse", reason: `invalid ref name ${JSON.stringify(ref)}` };
    updates.push({ old, new: next, ref });
    if (updates.length > MAX_UPDATES) return { kind: "refuse", reason: `more than ${MAX_UPDATES} ref updates in one push` };
  }
  if (capabilities === undefined || updates.length === 0) return { kind: "refuse", reason: "no ref updates" };
  for (const cap of capabilities) {
    if (!CAPABILITIES.has(cap) && !VALUED_CAPABILITIES.some((prefix) => cap.startsWith(prefix) && /^[\x21-\x7e]+$/.test(cap))) {
      return { kind: "refuse", reason: `unsupported capability ${JSON.stringify(cap.slice(0, 40))}` };
    }
  }
  const format = capabilities.find((cap) => cap.startsWith("object-format="))?.slice(14) ?? "sha1";
  const width = format === "sha1" ? 40 : format === "sha256" ? 64 : 0;
  if (width === 0) return { kind: "refuse", reason: "unknown object format" };
  if (updates.some((u) => u.old.length !== width) || shallow.some((oid) => oid.length !== width)) return { kind: "refuse", reason: "object ids do not match the object format" };
  let pushOptions: ReadonlyArray<string> = [];
  let end = first.end;
  if (capabilities.includes("push-options")) {
    const second = readPackets(bytes, 1, end);
    if (second === "incomplete") return { kind: "incomplete" };
    if ("refuse" in second) return { kind: "refuse", reason: second.refuse };
    pushOptions = second.lines.slice(0, -1) as ReadonlyArray<string>;
    if (pushOptions.length > MAX_PUSH_OPTIONS || pushOptions.some((option) => !/^[\x20-\x7e]{1,512}$/.test(option))) return { kind: "refuse", reason: "malformed push options" };
    end = second.end;
  }
  return { kind: "commands", updates, shallow, capabilities, pushOptions, consumed: end };
};

const encoder = new TextEncoder();

/** One pkt-line of `payload` (text or bytes). */
const pktLine = (payload: string | Uint8Array): Uint8Array => {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  const out = new Uint8Array(bytes.length + 4);
  out.set(encoder.encode((bytes.length + 4).toString(16).padStart(4, "0")), 0);
  out.set(bytes, 4);
  return out;
};
const FLUSH = encoder.encode("0000");
const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** The command list (and push options) GitHub is sent: built from what was parsed, never the Container's bytes. */
export const serialiseCommands = (parsed: Extract<ParsedCommands, { kind: "commands" }>): Uint8Array =>
  concat([
    ...parsed.shallow.map((oid) => pktLine(`shallow ${oid}`)),
    ...parsed.updates.map((update, at) => pktLine(`${update.old} ${update.new} ${update.ref}${at === 0 ? `\0 ${parsed.capabilities.join(" ")}` : ""}`)),
    FLUSH,
    ...(parsed.capabilities.includes("push-options") ? [...parsed.pushOptions.map((option) => pktLine(option)), FLUSH] : []),
  ]);

/**
 * The answer to a push the policy refused, as receive-pack's own report: `unpack ok`, then `ng <ref> <reason>` for each
 * update, inside side-band channel 1 when the client asked for it (and the reason on channel 2, which git prints as
 * `remote: …`). Without report-status, a 403 with the reason.
 */
export const refusalResponse = (parsed: Extract<ParsedCommands, { kind: "commands" }>, reason: string): Response => {
  const caps = new Set(parsed.capabilities);
  const oneLine = reason.replace(/[\r\n]+/g, " ").slice(0, 300);
  if (!caps.has("report-status") && !caps.has("report-status-v2")) return new Response(`t3flare: ${oneLine}\n`, { status: 403, headers: { "content-type": "text/plain" } });
  const report = concat([pktLine("unpack ok\n"), ...parsed.updates.map((update) => pktLine(`ng ${update.ref} ${oneLine}\n`)), FLUSH]);
  const band = caps.has("side-band-64k") ? 65_515 : caps.has("side-band") ? 995 : 0;
  let body: Uint8Array;
  if (band === 0) body = report;
  else {
    const frames: Array<Uint8Array> = [pktLine(concat([new Uint8Array([2]), encoder.encode(`t3flare: ${oneLine}\n`)]))];
    for (let at = 0; at < report.length; at += band) frames.push(pktLine(concat([new Uint8Array([1]), report.subarray(at, at + band)])));
    body = concat([...frames, FLUSH]);
  }
  return new Response(body, { status: 200, headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-store" } });
};

/** Where the Container's pushes arrive (`pushInsteadOf` in the image's system gitconfig, review M5). */
export const GATEWAY_PREFIX = "/t3flare/git/";

export interface GatewayDeps {
  /** The Workspace's GitHub repo from the registry (never from the request), or null: nothing is forwarded. */
  readonly repo: { readonly owner: string; readonly name: string } | null;
  /** The gateway's write token (`contents: write`, review M4): only ever sent to github.com in a header. */
  readonly token: () => Promise<string>;
  /**
   * The push policy (Workspace DO `authorizePush`): may hold the request while the owner is asked. `signal` aborts when
   * git goes away meanwhile (a CLI's command timeout, review M7), so the owner's card is withdrawn.
   */
  readonly authorize: (push: { readonly updates: ReadonlyArray<RefUpdate>; readonly pushOptions: ReadonlyArray<string> }, signal: AbortSignal) => Promise<{ readonly allow: true } | { readonly allow: false; readonly reason: string }>;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
}

const text = (status: number, message: string): Response => new Response(`t3flare: ${message}\n`, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } });

/** The headers GitHub is sent: an allowlist (review M1), our user agent, and the gateway's token. */
export const upstreamHeaders = (incoming: Headers, token: string, post: boolean): Headers => {
  const headers = new Headers({ "user-agent": "t3flare-push-gateway", authorization: `Basic ${btoa(`x-access-token:${token}`)}` });
  const accept = incoming.get("accept");
  if (accept !== null && /^[\w./+*-]+(?:, *[\w./+*-]+)*$/.test(accept)) headers.set("accept", accept);
  const protocol = incoming.get("git-protocol");
  if (protocol !== null && /^version=[01]$/.test(protocol)) headers.set("git-protocol", protocol);
  if (post) headers.set("content-type", "application/x-git-receive-pack-request");
  return headers;
};

/** The response the Container is sent: GitHub's status and body, only its content type. A redirect is never followed. */
const downstream = (response: Response): Response => {
  if (response.status >= 300 && response.status < 400) return text(502, `GitHub answered a redirect (${response.status}); not followed`);
  const headers = new Headers({ "cache-control": "no-store" });
  const type = response.headers.get("content-type");
  if (type !== null) headers.set("content-type", type);
  return new Response(response.body, { status: response.status, headers });
};

const PATH = /^\/t3flare\/git\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/(info\/refs|git-receive-pack)$/;

/**
 * The push gateway (SPI-992): a Container's receive-pack requests, forwarded to `https://github.com/<repo>` with the
 * gateway's token only after the policy allowed the request's exact ref updates. Only `GET info/refs?service=git-receive-pack`
 * (no side effects) and `POST git-receive-pack` for the Workspace's own repo; anything else is 404.
 */
export const handleGitRequest = async (request: Request, deps: GatewayDeps): Promise<Response> => {
  const url = new URL(request.url);
  const match = PATH.exec(url.pathname);
  if (match === null || deps.repo === null) return text(404, "not a push gateway path");
  const [, owner, name, what] = match as unknown as [string, string, string, string];
  if (owner.toLowerCase() !== deps.repo.owner.toLowerCase() || name.toLowerCase() !== deps.repo.name.toLowerCase()) return text(404, "pushes go only to this Workspace's repository");
  const base = `https://github.com/${deps.repo.owner}/${deps.repo.name}.git`;
  if (what === "info/refs") {
    if (request.method !== "GET" || url.search !== "?service=git-receive-pack") return text(404, "only the receive-pack advertisement");
    return downstream(await deps.fetch(`${base}/info/refs?service=git-receive-pack`, { method: "GET", headers: upstreamHeaders(request.headers, await deps.token(), false), redirect: "manual" }));
  }
  if (request.method !== "POST" || url.search !== "") return text(404, "only POST git-receive-pack");
  if (request.headers.get("content-encoding") !== null) return text(415, "compressed receive-pack requests are not accepted");
  if (request.headers.get("content-type") !== "application/x-git-receive-pack-request") return text(415, "not a receive-pack request");
  if (request.body === null) return text(400, "no request body");
  const reader = request.body.getReader();
  let buffered: Uint8Array = new Uint8Array();
  let parsed: ParsedCommands = { kind: "incomplete" };
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) done = true;
    else buffered = concat([buffered, chunk.value]);
    parsed = parseCommands(buffered);
    if (parsed.kind === "refuse" || parsed.kind === "commands") break;
    if (buffered.length > MAX_PREFIX_BYTES) {
      parsed = { kind: "refuse", reason: "the push's command list is too large" };
      break;
    }
  }
  if (parsed.kind === "incomplete") return text(400, "the request ended inside the command list");
  if (parsed.kind === "refuse") {
    void reader.cancel().catch(() => undefined);
    return text(400, parsed.reason);
  }
  if (parsed.kind === "probe") {
    // git's probe (`0000`, P4): updates nothing; a constant, never the Container's bytes.
    const token = await deps.token();
    return downstream(await deps.fetch(`${base}/git-receive-pack`, { method: "POST", headers: upstreamHeaders(request.headers, token, true), body: FLUSH, redirect: "manual" }));
  }
  // While the policy decides (the owner may be asked), the next read of the body notices git going away; a chunk it
  // reads is kept for GitHub.
  const gone = new AbortController();
  const onAbort = () => gone.abort();
  request.signal.addEventListener("abort", onAbort);
  let early: Promise<ReadableStreamReadResult<Uint8Array>> | undefined = done ? undefined : reader.read();
  early?.catch(() => gone.abort());
  const decision = await deps.authorize({ updates: parsed.updates, pushOptions: parsed.pushOptions }, gone.signal).finally(() => request.signal.removeEventListener("abort", onAbort));
  if (gone.signal.aborted) return text(499, "git went away while the push waited");
  if (!decision.allow) {
    void reader.cancel().catch(() => undefined);
    return refusalResponse(parsed, decision.reason);
  }
  const commands = parsed;
  const rest = buffered.subarray(commands.consumed);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(serialiseCommands(commands));
      if (rest.length > 0) controller.enqueue(rest);
    },
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      if (early !== undefined) {
        chunk = await early;
        early = undefined;
        if (chunk.done) done = true;
      } else chunk = done ? { done: true, value: undefined } : await reader.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const token = await deps.token();
  return downstream(await deps.fetch(`${base}/git-receive-pack`, { method: "POST", headers: upstreamHeaders(request.headers, token, true), body, redirect: "manual", duplex: "half" } as RequestInit));
};
