// The model catalog: the models the deployment's model proxy serves, read from its `GET /v1/models` (ADR-0012; the
// contract is Commissary's, docs/model-proxy.md). Both Workers keep their own copy in their Durable Object's storage
// and read it again once it is older than `CATALOG_TTL_MS`; a read that fails keeps the copy there is, and before the
// first read that succeeds the catalog is the static list (`STATIC_CATALOG`).
//
// Commissary answers `/v1/models` in one of two shapes, by the request's headers. Without `anthropic-version` it is
// OpenAI's: every model under its real id (`gemini-3-flash`), with no display name or limits. With it, Anthropic's:
// every model has a display name and limits, but a model that is not Claude is listed under an alias, `claude-fable-5-dd-`
// and its real id spelled backwards (`claude-fable-5-dd-eerf-maeb` is `beam-free`). Both are read and merged by real id,
// and only real ids reach the picker, the Session or a request. A proxy that answers one shape for both, or only the
// Anthropic one (Anthropic's own API), still gives a catalog.
//
// Every listed model is served through the Anthropic Messages API (the proxy translates), so each is `anthropic/<id>`.
import { CATALOG, type CatalogModel, OTHER_VENDOR, vendorOf } from "./index.ts";

export interface ModelProxy {
  readonly url: string;
  readonly apiKey: string;
}

/** The catalog, and when it was read from the proxy (null: never; it is the static list). */
export interface Catalog {
  readonly models: ReadonlyArray<CatalogModel>;
  readonly fetchedAt: number | null;
}

/** The static list, before the proxy's has ever been read (and the whole catalog where it never can be). */
export const STATIC_CATALOG: Catalog = { models: CATALOG, fetchedAt: null };

/** How old the kept catalog may be before it is read again. */
export const CATALOG_TTL_MS = 15 * 60 * 1000;
/** How long after a failed read none is tried again (a forced one included): a proxy that is down costs one timeout. */
export const CATALOG_RETRY_MS = 60 * 1000;
/** How long the reads of one refresh may take. */
export const CATALOG_FETCH_TIMEOUT_MS = 5_000;
/** The limits of a model whose own the proxy does not say. */
export const UNKNOWN_LIMITS = { contextWindow: 200_000, maxTokens: 32_000 } as const;
/** What `models.json` gives the Claude models: the window a Claude model is held to, whatever the proxy says. */
export const CLAUDE_CONTEXT_WINDOW = 400_000;

const CLOAK_PREFIX = "claude-fable-5-dd-";
const MAX_PAGES = 10;

/** One model of a proxy's list, in either shape: every field but the id is optional. */
export interface ListedModel {
  readonly id: string;
  readonly displayName?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

/** A page of a list in either shape, or undefined when the body is not one. */
export const parseList = (
  body: unknown,
): { readonly models: ReadonlyArray<ListedModel>; readonly lastId: string | undefined } | undefined => {
  if (!isRecord(body) || !Array.isArray(body.data)) return undefined;
  const models: Array<ListedModel> = [];
  for (const entry of body.data as ReadonlyArray<unknown>) {
    if (!isRecord(entry)) continue;
    const id = text(entry.id);
    if (id === undefined) continue;
    const displayName = text(entry.display_name);
    const contextWindow = count(entry.max_input_tokens);
    const maxTokens = count(entry.max_tokens);
    models.push({
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
  }
  return { models, lastId: body.has_more === true ? text(body.last_id) : undefined };
};

/** The real id behind an alias the proxy lists a non-Claude model under (the id itself when it is not one). */
export const realIdOf = (id: string): string => (id.startsWith(CLOAK_PREFIX) ? [...id.slice(CLOAK_PREFIX.length)].reverse().join("") : id);

/** A Claude model by name: its family and version, optionally dated, nothing after (`claude-opus-5-5`, `claude-haiku-4-5-20251001`). */
const CLAUDE = /^claude-(?:fable|opus|sonnet|haiku)-\d+(?:-\d{1,2})?(?:-\d{8})?$/;

/** The model as the catalog holds it: a Claude model keeps what `models.json` gives it (thinking, images, the window cap). */
export const catalogModelOf = (listed: ListedModel): CatalogModel => {
  const claude = CLAUDE.test(listed.id);
  const contextWindow = listed.contextWindow ?? UNKNOWN_LIMITS.contextWindow;
  return {
    id: listed.id,
    name: listed.displayName ?? listed.id,
    reasoning: claude,
    input: claude ? ["text", "image"] : ["text"],
    contextWindow: claude ? Math.min(contextWindow, CLAUDE_CONTEXT_WINDOW) : contextWindow,
    maxTokens: listed.maxTokens ?? UNKNOWN_LIMITS.maxTokens,
    provider: "anthropic",
    vendor: vendorOf(listed.id) ?? OTHER_VENDOR,
    api: "anthropic-messages",
    slug: `anthropic/${listed.id}`,
  };
};

/**
 * The two lists merged by real id. `plain` (no `anthropic-version`) says which models there are; `anthropic` (with it)
 * says what each is called and allows, under its alias where it has one. Either may be missing: with only `anthropic`
 * the aliases are read back to their real ids. An alias `plain` does not list is dropped. Empty when there is nothing.
 */
export const mergeLists = (
  plain: ReadonlyArray<ListedModel> | undefined,
  anthropic: ReadonlyArray<ListedModel> | undefined,
): ReadonlyArray<CatalogModel> => {
  const known = new Map<string, ListedModel>();
  for (const model of anthropic ?? []) {
    const id = realIdOf(model.id);
    if (plain !== undefined && id !== model.id && !plain.some((listed) => listed.id === id)) continue;
    known.set(id, { ...model, id });
  }
  const merged = new Map<string, ListedModel>();
  for (const model of plain ?? []) {
    const richer = known.get(model.id);
    merged.set(model.id, { ...model, ...richer, id: model.id });
  }
  for (const [id, model] of known) if (!merged.has(id)) merged.set(id, model);
  return [...merged.values()].map(catalogModelOf);
};

const readList = async (url: URL, headers: Record<string, string>, fetcher: typeof fetch, signal: AbortSignal) => {
  const response = await fetcher(url, { headers, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const page = parseList(await response.json());
  if (page === undefined) throw new Error("not a list of models");
  return page;
};

/** Read the proxy's catalog, or throw an Error that says why not. */
export const fetchCatalog = async (proxy: ModelProxy, fetcher: typeof fetch, signal: AbortSignal): Promise<ReadonlyArray<CatalogModel>> => {
  const base = proxy.url.replace(/\/+$/, "");
  const plain = readList(new URL(`${base}/v1/models`), { "x-api-key": proxy.apiKey }, fetcher, signal).then((page) => page.models);
  const anthropic = (async () => {
    const models: Array<ListedModel> = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(`${base}/v1/models`);
      url.searchParams.set("limit", "1000");
      if (after !== undefined) url.searchParams.set("after_id", after);
      const answer = await readList(url, { "x-api-key": proxy.apiKey, "anthropic-version": "2023-06-01" }, fetcher, signal);
      models.push(...answer.models);
      if (answer.lastId === undefined) break;
      after = answer.lastId;
    }
    return models;
  })();
  const [plainResult, anthropicResult] = await Promise.allSettled([plain, anthropic]);
  const merged = mergeLists(
    plainResult.status === "fulfilled" ? plainResult.value : undefined,
    anthropicResult.status === "fulfilled" ? anthropicResult.value : undefined,
  );
  if (merged.length > 0) return merged;
  const why = (result: PromiseSettledResult<unknown>) => (result.status === "rejected" ? String(result.reason instanceof Error ? result.reason.message : result.reason) : "no models");
  throw new Error(`The model proxy's list of models: ${why(plainResult)}; with anthropic-version: ${why(anthropicResult)}`);
};

/** Whether a stored value is a catalog of this shape: a copy kept by an older deploy may not be one. */
export const isCatalog = (value: unknown): value is Catalog =>
  isRecord(value) &&
  (value.fetchedAt === null || typeof value.fetchedAt === "number") &&
  Array.isArray(value.models) &&
  value.models.every(
    (model) =>
      isRecord(model) &&
      typeof model.id === "string" &&
      typeof model.slug === "string" &&
      typeof model.name === "string" &&
      typeof model.vendor === "string" &&
      typeof model.reasoning === "boolean" &&
      Array.isArray(model.input) &&
      typeof model.contextWindow === "number" &&
      typeof model.maxTokens === "number",
  );

/** Where a catalog is kept between reads: a Durable Object's storage. */
export interface CatalogStore {
  readonly read: () => unknown;
  readonly write: (catalog: Catalog) => void;
}

export type CatalogRefresh =
  | { readonly status: "fresh" }
  | { readonly status: "fetched"; readonly models: number }
  | { readonly status: "failed"; readonly message: string };

export interface ModelCatalog {
  /** The catalog as kept: the static list before the proxy's was ever read. */
  readonly current: () => Catalog;
  /** A model by its t3 slug (`anthropic/<id>`). */
  readonly find: (slug: string) => CatalogModel | undefined;
  /**
   * Read the proxy's catalog when the kept one is older than `CATALOG_TTL_MS` (`force`: whatever its age), unless a read
   * failed within `CATALOG_RETRY_MS`. One read at a time. Never rejects; a read that fails keeps the catalog as it was.
   */
  readonly refresh: (options?: { readonly force?: boolean }) => Promise<CatalogRefresh>;
}

export const modelCatalog = (options: {
  readonly store: CatalogStore;
  /** None (a stage without one): the static list is all there is. */
  readonly proxy: ModelProxy | undefined;
  readonly now?: () => number;
  readonly fetcher?: typeof fetch;
}): ModelCatalog => {
  const { store, proxy } = options;
  const now = options.now ?? Date.now;
  let kept: Catalog | undefined;
  let failedAt: number | undefined;
  let inFlight: Promise<CatalogRefresh> | undefined;

  const current = (): Catalog => {
    if (kept === undefined) {
      const stored = store.read();
      kept = isCatalog(stored) && stored.models.length > 0 ? stored : STATIC_CATALOG;
    }
    return kept;
  };

  const read = async (target: ModelProxy): Promise<CatalogRefresh> => {
    try {
      const models = await fetchCatalog(target, options.fetcher ?? fetch, AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS));
      kept = { models, fetchedAt: now() };
      store.write(kept);
      failedAt = undefined;
      return { status: "fetched", models: models.length };
    } catch (error) {
      failedAt = now();
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    current,
    find: (slug) => current().models.find((model) => model.slug === slug),
    refresh: (refreshOptions) => {
      if (inFlight !== undefined) return inFlight;
      if (proxy === undefined) return Promise.resolve({ status: "fresh" });
      const at = now();
      const { fetchedAt } = current();
      if (failedAt !== undefined && at - failedAt < CATALOG_RETRY_MS) return Promise.resolve({ status: "fresh" });
      if (refreshOptions?.force !== true && fetchedAt !== null && at - fetchedAt < CATALOG_TTL_MS) return Promise.resolve({ status: "fresh" });
      inFlight = read(proxy).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
};
