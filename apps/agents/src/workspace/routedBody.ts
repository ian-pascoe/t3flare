// The model relay's model-routed body (SPI-1168): a request to `…/t3flare/model/_` names its endpoint in its JSON body's
// top-level `model` (`<endpointId>/<modelId>`). The body is read into one buffer, scanned as bytes (JSON's structure is
// ASCII, so UTF-8 needs no decoding to find it), and the model's own id is written over the slug in place: the rest of
// the body is passed byte for byte. With a declared length the relay holds one copy; without one, the buffer doubles as
// it fills, briefly holding the old and the new (under twice the cap). Pure.
import { ENDPOINT_ID, parseEndpointSlug } from "@t3flare/models/endpoints";

/**
 * The largest model-routed body (16 MiB). It is held whole while it is scanned, one buffer per request, in an isolate
 * of 128 MB that relays other requests too: 16 MiB leaves room for several at once. Claude Code's requests are tens to
 * hundreds of kilobytes (p1168's first was 84 KB); a body over it is refused (413), which Claude Code reports.
 */
export const MAX_ROUTED_BODY_BYTES = 16 * 1024 * 1024;

/** The deepest nesting of arrays and objects the scan follows: deeper is refused (400). */
export const MAX_NESTING = 512;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;
const isWhitespace = (byte: number | undefined) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A JSON value's bytes parsed (a key or the model), or undefined when they are not valid UTF-8 JSON. */
const parsed = (bytes: Uint8Array, start: number, end: number): unknown => {
  try {
    return JSON.parse(decoder.decode(bytes.subarray(start, end)));
  } catch {
    return undefined;
  }
};

/** The index after the JSON string starting at `at` (its opening quote), or -1 when it does not end. */
const stringEnd = (bytes: Uint8Array, at: number): number => {
  for (let i = at + 1; i < bytes.length; i++) {
    if (bytes[i] === BACKSLASH) i++;
    else if (bytes[i] === QUOTE) return i + 1;
  }
  return -1;
};

/** The index after the JSON value starting at `at`, or -1 when it is cut off, its brackets do not match or it nests too deep. */
const valueEnd = (bytes: Uint8Array, at: number): number => {
  const first = bytes[at];
  if (first === QUOTE) return stringEnd(bytes, at);
  if (first === OPEN_OBJECT || first === OPEN_ARRAY) {
    const open: Array<number> = [];
    for (let i = at; i < bytes.length; i++) {
      const byte = bytes[i]!;
      if (byte === QUOTE) {
        i = stringEnd(bytes, i) - 1;
        if (i < 0) return -1;
      } else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
        // The depth this opens, counting the top-level object.
        if (open.length + 2 > MAX_NESTING) return -1;
        open.push(byte === OPEN_OBJECT ? CLOSE_OBJECT : CLOSE_ARRAY);
      } else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
        if (open.pop() !== byte) return -1;
        if (open.length === 0) return i + 1;
      }
    }
    return -1;
  }
  let i = at;
  while (i < bytes.length && !isWhitespace(bytes[i]) && bytes[i] !== COMMA && bytes[i] !== CLOSE_OBJECT && bytes[i] !== CLOSE_ARRAY) i++;
  return i === at ? -1 : i;
};

/**
 * Where a JSON object's one top-level `model` member's string value is (`start` to `end`, quotes included), and the
 * value. Keys are read as JSON reads them (`"mod\u0065l"` is `model`). Undefined when the bytes are not one object (a
 * BOM is not JSON), its `model` is not a string, it has none or two, or a value nests deeper than `MAX_NESTING`.
 */
export const topLevelModel = (bytes: Uint8Array): { readonly start: number; readonly end: number; readonly value: string } | undefined => {
  let i = 0;
  const skip = () => {
    while (i < bytes.length && isWhitespace(bytes[i])) i++;
  };
  skip();
  if (bytes[i] !== OPEN_OBJECT) return undefined;
  i++;
  let found: { start: number; end: number; value: string } | undefined;
  let models = 0;
  skip();
  if (bytes[i] === CLOSE_OBJECT) return undefined;
  for (;;) {
    skip();
    if (bytes[i] !== QUOTE) return undefined;
    const keyEnd = stringEnd(bytes, i);
    if (keyEnd < 0) return undefined;
    const key = parsed(bytes, i, keyEnd);
    if (typeof key !== "string") return undefined;
    i = keyEnd;
    skip();
    if (bytes[i] !== COLON) return undefined;
    i++;
    skip();
    const start = i;
    const end = valueEnd(bytes, i);
    if (end < 0) return undefined;
    if (key === "model") {
      models++;
      const value = parsed(bytes, start, end);
      if (typeof value !== "string") return undefined;
      found = { start, end, value };
    }
    i = end;
    skip();
    if (bytes[i] === COMMA) {
      i++;
      continue;
    }
    if (bytes[i] !== CLOSE_OBJECT) return undefined;
    i++;
    skip();
    return i === bytes.length && models === 1 ? found : undefined;
  }
};

/** A routed body's endpoint, and the body with the model's own id in place of the slug. */
export interface RoutedBody {
  readonly endpointId: string;
  /** The model's own id at the endpoint (what its usage is recorded under, SPI-1173). */
  readonly modelId: string;
  readonly body: Uint8Array;
}

/**
 * The endpoint `bytes` names and the body to send it, or undefined when it names none. `bytes` is the relay's own
 * buffer: the model's id is written over the slug in place (it is never longer), so no second copy is made.
 */
export const routeBody = (bytes: Uint8Array): RoutedBody | undefined => {
  const model = topLevelModel(bytes);
  const slug = model === undefined ? undefined : parseEndpointSlug(model.value);
  if (model === undefined || slug === undefined || !ENDPOINT_ID.test(slug.endpointId)) return undefined;
  const id = new TextEncoder().encode(JSON.stringify(slug.modelId));
  const removed = model.end - model.start - id.length;
  // `"<model>"` is shorter than `"<endpointId>/<model>"` in any encoding: JSON.stringify's is the shortest of its value.
  if (removed <= 0) throw new Error("t3flare: a model id is not shorter than its slug");
  bytes.set(id, model.start);
  bytes.copyWithin(model.start + id.length, model.end);
  return { endpointId: slug.endpointId, modelId: slug.modelId, body: bytes.subarray(0, bytes.length - removed) };
};

/** The declared length of a request's body, when it declares a valid one. */
export const declaredLength = (headers: Headers): number | undefined => {
  const value = headers.get("content-length");
  return value !== null && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
};

/**
 * A body read into one buffer, sized by its declared length when there is one (the caller refuses one over the cap),
 * or `tooLarge` once what it streams passes the cap (the rest is not read).
 */
export const readCapped = async (body: ReadableStream<Uint8Array> | null, declared: number | undefined): Promise<{ readonly bytes: Uint8Array } | { readonly tooLarge: true }> => {
  if (body === null) return { bytes: new Uint8Array(0) };
  let buffer = new Uint8Array(Math.min(declared ?? 64 * 1024, MAX_ROUTED_BODY_BYTES));
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > MAX_ROUTED_BODY_BYTES) {
      void reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    if (size + value.byteLength > buffer.length) {
      const grown = new Uint8Array(Math.min(MAX_ROUTED_BODY_BYTES, Math.max(buffer.length * 2, size + value.byteLength)));
      grown.set(buffer.subarray(0, size));
      buffer = grown;
    }
    buffer.set(value, size);
    size += value.byteLength;
  }
  return { bytes: buffer.subarray(0, size) };
};
