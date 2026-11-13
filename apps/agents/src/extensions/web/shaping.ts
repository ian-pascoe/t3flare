// Copied from cloudpid@93ba45a3:packages/extensions/src/web/search.ts (SPI-1054; see ./NOTICE.md): `web_search`'s
// answer shaping (its Exa-style result list shares the `contextMaxCharacters` budget so each result keeps its Title and
// URL) and the sanitizer for text a provider controls, unchanged but for this header and the exports. `search.ts`
// writes its results in the same `Title:`/`URL:` shape so the same budget applies.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off missedPipeableOpportunity:off
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

/** Default total budget for Search Provider text, in Unicode code points. */
export const DEFAULT_CONTEXT_MAX_CHARACTERS = 6000;
export const MAX_CONTEXT_MAX_CHARACTERS = 50_000;
const MAX_PROVIDER_MESSAGE_CHARACTERS = 500;

/** The first `limit` Unicode code points of `text`. */
export const truncateCodePoints = (text: string, limit: number): string =>
  // UTF-16 length never undercounts code points, so shorter text is certainly within the limit.
  text.length <= limit ? text : Arr.join(Arr.take(Array.from(text), limit), "");

/** Turns provider-controlled text into one short, key-free, control-free line. */
export type Sanitize = (text: string) => string;

// --- Keys never reach the model --------------------------------------------------------------------------------

const secretVariants = (secret: string): string[] => [
  secret,
  encodeURIComponent(secret),
  new URLSearchParams({ k: secret }).toString().slice(2),
];

/** Remove the API keys, in every encoding a URL might carry, from echoed text. */
const redactKeys = (message: string, keys: readonly string[]): string =>
  Arr.reduce(keys, message, (text, key) =>
    key === ""
      ? text
      : Arr.reduce(secretVariants(key), text, (redacted, variant) =>
          redacted.replaceAll(variant, "[REDACTED]"),
        ),
  );

// Terminal escape sequences start with ESC; they are removed from provider text.
const TERMINAL_SEQUENCE =
  // oxlint-disable-next-line eslint/no-control-regex -- SAFETY: Matching ESC and BEL is the purpose of this expression.
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;

// oxlint-disable-next-line eslint/no-control-regex -- SAFETY: Matching control characters is the purpose of this expression.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * The sanitizer for text a Search Provider controls. Keys are redacted before anything is cut and again after control
 * characters are removed, so no key fragment survives truncation.
 */
export const providerTextSanitizer =
  (keys: readonly string[]): Sanitize =>
  (text) => {
    const stripped = redactKeys(text, keys)
      .replace(TERMINAL_SEQUENCE, "")
      .replace(CONTROL_CHARACTERS, "")
      .replace(/\p{Cf}/gu, "");

    const collapsed = redactKeys(stripped, keys).replace(/\s+/g, " ").trim();

    return truncateCodePoints(collapsed, MAX_PROVIDER_MESSAGE_CHARACTERS) === collapsed
      ? collapsed
      : `${truncateCodePoints(collapsed, MAX_PROVIDER_MESSAGE_CHARACTERS)}…`;
  };

const EXA_RESULT_START = /(?:^|\n\n)(?=Title: [^\n]*\nURL: )/;
const EXA_RESULT_SEPARATOR = "\n\n";

/** Exa's metadata keys; the first line with any other key (`Highlights:`, `Text:`, ...) opens the body. */
const EXA_HEADER_LINE = /^(?:Title|URL|Published Date|Published|Author|Image|Favicon|ID|Score): /;

/** The lines a model needs to choose a URL for `web_fetch`. */
const EXA_ESSENTIAL_LINE = /^(?:Title|URL): /;

/** A metadata line Exa fills with `N/A`; it tells the model nothing and only spends budget. */
const EXA_EMPTY_HEADER_LINE = /^[^:]+: N\/A$/;

/** Below this many code points a body share shows only a stub such as `Hi` (from `Highlights:`), so the body is dropped. */
const MIN_USEFUL_BODY_CHARACTERS = 80;

/** One Exa result: all metadata lines, just Title and URL, and the body that follows the metadata. */
type ExaResult = {
  readonly header: string;
  readonly essentialHeader: string;
  readonly body: string;
};

const splitExaResults = (text: string): ExaResult[] | undefined => {
  const blocks = Arr.filter(text.split(EXA_RESULT_START), (block) => block !== "");

  if (blocks.length === 0 || !Arr.every(blocks, (block) => block.startsWith("Title: "))) {
    return undefined;
  }

  return Arr.map(blocks, (block) => {
    const lines = block.split("\n");
    let count = 0;

    while (count < lines.length && EXA_HEADER_LINE.test(lines[count] ?? "")) count++;

    const headerLines = lines.slice(0, count);

    return {
      header: Arr.join(
        Arr.filter(
          headerLines,
          (line) => EXA_ESSENTIAL_LINE.test(line) || !EXA_EMPTY_HEADER_LINE.test(line),
        ),
        "\n",
      ),
      essentialHeader: Arr.join(
        Arr.filter(headerLines, (line) => EXA_ESSENTIAL_LINE.test(line)),
        "\n",
      ),
      body: block.slice(Arr.join(headerLines, "\n").length),
    };
  });
};

const joinExaResults = (results: readonly ExaResult[]): string =>
  Arr.join(
    Arr.map(results, ({ header, body }) => header + body),
    EXA_RESULT_SEPARATOR,
  );

/**
 * The hint for reading more. The model did not choose the default budget, so only a default cut says how to raise it;
 * an explicit budget is already the model's own choice.
 */
const moreHint = (explicit: number | undefined): string =>
  explicit === undefined
    ? `; pass contextMaxCharacters (up to ${MAX_CONTEXT_MAX_CHARACTERS}) for more`
    : "";

type Body = { readonly length: number; readonly index: number };

const byIndex = Order.mapInput(Order.Number, (body: Body) => body.index);

const byLengthThenIndex = Order.combine(
  Order.mapInput(Order.Number, (body: Body) => body.length),
  byIndex,
);

/** Split `budget` code points over bodies: short ones keep all, the rest share what remains evenly. */
const shareBodyBudget = (lengths: readonly number[], budget: number): number[] => {
  const shares = [...lengths];
  let remaining = budget;

  let pending = Arr.sort(
    Arr.map(lengths, (length, index): Body => ({ length, index })),
    byLengthThenIndex,
  );

  while (pending.length > 0) {
    const fair = Math.floor(remaining / pending.length);
    const first = pending[0];

    if (first === undefined || first.length > fair) break;

    remaining -= first.length;
    pending = pending.slice(1);
  }

  let extra = pending.length === 0 ? 0 : remaining % pending.length;
  const fair = pending.length === 0 ? 0 : Math.floor(remaining / pending.length);

  for (const { index } of Arr.sort(pending, byIndex)) {
    shares[index] = fair + (extra > 0 ? 1 : 0);

    if (extra > 0) extra--;
  }

  return shares;
};

/**
 * Split `limit` code points across an Exa result list so every result keeps its header lines and a fair share of its
 * body. When the full headers do not fit, only each Title and URL line is kept. A body whose share is too small to
 * read is dropped. Undefined when even the Title and URL lines do not fit, so the caller falls back to one plain cut.
 */
const shareSearchBudget = (
  results: readonly ExaResult[],
  limit: number,
  explicit: number | undefined,
): string | undefined => {
  const separators = EXA_RESULT_SEPARATOR.length * (results.length - 1);

  const fixedLength = (headers: readonly string[]): number =>
    Arr.reduce(headers, separators, (sum, header) => sum + Array.from(header).length);

  let headers = Arr.map(results, ({ header }) => header);
  let reduced = false;

  if (fixedLength(headers) > limit) {
    headers = Arr.map(results, ({ essentialHeader }) => essentialHeader);
    reduced = true;

    if (fixedLength(headers) > limit) return undefined;
  }

  const bodies = Arr.map(results, ({ body }) => Array.from(body));

  const shares = shareBodyBudget(
    Arr.map(bodies, (body) => body.length),
    limit - fixedLength(headers),
  );

  const cut: number[] = [];

  const kept = Arr.map(headers, (header, index) => {
    const body = bodies[index] ?? [];
    const fullShare = shares[index] ?? 0;

    if (body.length <= fullShare) return header + Arr.join(body, "");

    cut.push(index + 1);

    const share = fullShare < MIN_USEFUL_BODY_CHARACTERS ? 0 : fullShare;

    return header + Arr.join(Arr.take(body, share), "");
  });

  const label = cut.length === 1 ? "result" : "results";

  const shortened =
    cut.length === 0 ? "" : `; ${label} ${Arr.join(Arr.map(cut, String), ", ")} shortened`;

  const dropped = reduced ? "; metadata other than Title and URL dropped" : "";

  return `${Arr.join(kept, EXA_RESULT_SEPARATOR)}\n\n[Search results cut at ${limit} characters, shared across ${results.length} results${shortened}${dropped}${moreHint(explicit)}; web_fetch a result's URL for the full page]`;
};

/**
 * Cut provider text at `contextMaxCharacters` code points (default 6,000), then mark the cut. An Exa result list
 * shares that budget so each result keeps its Title and URL; other text is cut once.
 */
export const limitSearchText = (providerText: string, explicit: number | undefined): string => {
  const limit = explicit ?? DEFAULT_CONTEXT_MAX_CHARACTERS;
  const results = splitExaResults(providerText);
  const text = results === undefined ? providerText : joinExaResults(results);
  const kept = truncateCodePoints(text, limit);

  if (kept === text) return text;

  const shared = results === undefined ? undefined : shareSearchBudget(results, limit, explicit);

  return shared ?? `${kept}\n\n[Search results cut at ${limit} characters${moreHint(explicit)}]`;
};

