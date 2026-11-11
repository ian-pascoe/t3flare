// The model catalog read from the proxy's `/v1/models` (ADR-0012, docs/model-proxy.md): the two shapes Commissary answers
// by its request's headers, merged by real id; the keeper that reads it again when it is old; the provider snapshot made
// from it. The lists are cut from Commissary's real answers of 2026-11-11.
// @effect-diagnostics globalFetch:off
import { DEFAULT_MODEL_SLUG } from "@t3flare/models";
import {
  CATALOG_RETRY_MS,
  CATALOG_TTL_MS,
  type Catalog,
  fetchCatalog,
  isCatalog,
  mergeLists,
  modelCatalog,
  parseList,
  realIdOf,
  STATIC_CATALOG,
  UNKNOWN_LIMITS,
} from "@t3flare/models/catalog";
import { describe, expect, it } from "vitest";

import { snapshotModels } from "../src/provider/models.ts";

/** What Commissary answers without `anthropic-version`: OpenAI's shape, real ids, nothing else. */
const PLAIN = {
  object: "list",
  data: [
    { id: "beam-free", object: "model", owned_by: "opencode" },
    { id: "claude-fable-5-2", object: "model", owned_by: "opencode" },
    { id: "claude-haiku-5-5", object: "model", owned_by: "opencode" },
    { id: "deepseek-v4.1-flash", object: "model", owned_by: "opencode" },
    { id: "gemini-3-flash", object: "model", owned_by: "antigravity" },
  ],
};

/** With it: Anthropic's shape, with names and limits, and the models that are not Claude under their aliases. */
const ANTHROPIC = {
  data: [
    { id: "claude-fable-5-dd-eerf-maeb", object: "model", owned_by: "opencode", type: "model", display_name: "Beam Free", max_input_tokens: 1048576, max_tokens: 131072 },
    { id: "claude-fable-5-2", object: "model", owned_by: "opencode", type: "model", display_name: "Claude Fable 5.2", max_input_tokens: 1000000, max_tokens: 128000 },
    { id: "claude-haiku-5-5", object: "model", owned_by: "opencode", type: "model", display_name: "Claude Haiku 5.5", max_input_tokens: 1000000, max_tokens: 128000 },
    { id: "claude-fable-5-dd-hsalf-1.4v-keespeed", object: "model", owned_by: "opencode", type: "model", display_name: "DeepSeek V4.1 Flash", max_input_tokens: 128000, max_tokens: 16000 },
    { id: "claude-fable-5-dd-hsalf-3-inimeg", object: "model", owned_by: "antigravity", type: "model", display_name: "Gemini 3 Flash", max_input_tokens: 1000000, max_tokens: 65536 },
    { id: "claude-fable-5-dd-ledom-a-ton", object: "model", owned_by: "opencode", type: "model", display_name: "Not Listed Plain", max_input_tokens: 1, max_tokens: 1 },
  ],
  has_more: false,
  first_id: "claude-fable-5-dd-eerf-maeb",
  last_id: "claude-fable-5-dd-ledom-a-ton",
};

const byId = <T extends { readonly id: string }>(models: ReadonlyArray<T>): Record<string, T | undefined> => Object.fromEntries(models.map((model) => [model.id, model]));

describe("reading the proxy's lists", () => {
  it("reads both shapes, every field but the id optional", () => {
    expect(parseList(PLAIN)?.models.map((model) => model.id)).toEqual(PLAIN.data.map((model) => model.id));
    expect(parseList(ANTHROPIC)?.models[0]).toEqual({
      id: "claude-fable-5-dd-eerf-maeb",
      displayName: "Beam Free",
      ownedBy: "opencode",
      contextWindow: 1048576,
      maxTokens: 131072,
    });
    expect(parseList({ data: [{ id: "x", display_name: null, max_tokens: 0 }, { nope: 1 }, "x"] })?.models).toEqual([{ id: "x" }]);
    expect(parseList({ data: [], has_more: true, last_id: "z" })?.lastId).toBe("z");
    expect(parseList({ data: [], has_more: false, last_id: "z" })?.lastId).toBeUndefined();
    expect(parseList({ models: [] })).toBeUndefined();
    expect(parseList("nope")).toBeUndefined();
  });

  it("reads an alias back to the real id", () => {
    expect(realIdOf("claude-fable-5-dd-eerf-maeb")).toBe("beam-free");
    expect(realIdOf("claude-fable-5-dd-hsalf-1.4v-keespeed")).toBe("deepseek-v4.1-flash");
    expect(realIdOf("claude-fable-5-2")).toBe("claude-fable-5-2");
  });
});

describe("merging the lists", () => {
  const merged = byId(mergeLists(parseList(PLAIN)?.models, parseList(ANTHROPIC)?.models));

  it("lists every model under its real id, with the Anthropic list's name and limits", () => {
    expect(Object.keys(merged)).toEqual(["beam-free", "claude-fable-5-2", "claude-haiku-5-5", "deepseek-v4.1-flash", "gemini-3-flash"]);
    expect(merged["gemini-3-flash"]).toMatchObject({
      name: "Gemini 3 Flash",
      slug: "anthropic/gemini-3-flash",
      provider: "anthropic",
      api: "anthropic-messages",
      ownedBy: "antigravity",
      contextWindow: 1000000,
      maxTokens: 65536,
      reasoning: false,
      input: ["text"],
    });
  });

  it("drops an alias the plain list does not list", () => {
    expect(merged["not-a-model"]).toBeUndefined();
    expect(Object.values(merged).some((model) => model.id.startsWith("claude-fable-5-dd-"))).toBe(false);
  });

  it("holds a Claude model to the window and abilities models.json gives the Claude models", () => {
    expect(merged["claude-fable-5-2"]).toMatchObject({ name: "Claude Fable 5.2", reasoning: true, input: ["text", "image"], contextWindow: 400_000, maxTokens: 128000 });
  });

  it("works from the Anthropic list alone, reading the aliases back", () => {
    const only = byId(mergeLists(undefined, parseList(ANTHROPIC)?.models));
    expect(Object.keys(only)).toContain("beam-free");
    expect(only["beam-free"]?.name).toBe("Beam Free");
    expect(Object.keys(only)).toContain("not-a-model");
  });

  it("works from the plain list alone: its ids, named by id, with the limits of an unknown model", () => {
    const only = byId(mergeLists(parseList(PLAIN)?.models, undefined));
    expect(only["gemini-3-flash"]).toMatchObject({ name: "gemini-3-flash", ...UNKNOWN_LIMITS, ownedBy: "antigravity" });
    expect(only["claude-haiku-5-5"]).toMatchObject({ reasoning: true, contextWindow: 200_000 });
  });

  it("is empty when there is nothing", () => {
    expect(mergeLists(undefined, undefined)).toEqual([]);
    expect(mergeLists([], [])).toEqual([]);
  });
});

/** A fetch that answers by the request's headers, as Commissary does, and records the requests. */
const proxyFetch = (answers: { readonly plain?: unknown; readonly anthropic?: unknown; readonly plainStatus?: number; readonly anthropicStatus?: number }) => {
  const calls: Array<{ readonly url: string; readonly headers: Headers }> = [];
  const fetcher = ((input: URL | string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), headers });
    const withVersion = headers.has("anthropic-version");
    const status = (withVersion ? answers.anthropicStatus : answers.plainStatus) ?? 200;
    const body = withVersion ? answers.anthropic : answers.plain;
    return Promise.resolve(new Response(JSON.stringify(body ?? {}), { status }));
  }) as typeof fetch;
  return { fetcher, calls };
};

const PROXY = { url: "https://proxy.example/", apiKey: "cms_key" };

describe("fetchCatalog", () => {
  it("asks for both lists with the key as x-api-key, the plain one without anthropic-version", async () => {
    const { fetcher, calls } = proxyFetch({ plain: PLAIN, anthropic: ANTHROPIC });
    const models = await fetchCatalog(PROXY, fetcher, AbortSignal.timeout(1000));
    expect(models.map((model) => model.id)).toContain("gemini-3-flash");
    const plain = calls.find((call) => !call.headers.has("anthropic-version"));
    const anthropic = calls.find((call) => call.headers.has("anthropic-version"));
    expect(plain?.url).toBe("https://proxy.example/v1/models");
    expect(plain?.headers.get("x-api-key")).toBe("cms_key");
    expect(anthropic?.url).toBe("https://proxy.example/v1/models?limit=1000");
    expect(anthropic?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(anthropic?.headers.get("x-api-key")).toBe("cms_key");
  });

  it("follows the Anthropic list's pages", async () => {
    const pages: Array<string> = [];
    const fetcher = ((input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (!new Headers(init?.headers).has("anthropic-version")) return Promise.resolve(new Response(JSON.stringify(PLAIN)));
      pages.push(url.searchParams.get("after_id") ?? "");
      const first = url.searchParams.get("after_id") === null;
      const body = first
        ? { data: [ANTHROPIC.data[1]], has_more: true, last_id: "claude-fable-5-2" }
        : { data: [ANTHROPIC.data[2]], has_more: false, last_id: "claude-haiku-5-5" };
      return Promise.resolve(new Response(JSON.stringify(body)));
    }) as typeof fetch;
    const models = byId(await fetchCatalog(PROXY, fetcher, AbortSignal.timeout(1000)));
    expect(pages).toEqual(["", "claude-fable-5-2"]);
    expect(models["claude-haiku-5-5"]?.name).toBe("Claude Haiku 5.5");
  });

  it("still gives a catalog when one list fails", async () => {
    const noPlain = await fetchCatalog(PROXY, proxyFetch({ anthropic: ANTHROPIC, plainStatus: 400 }).fetcher, AbortSignal.timeout(1000));
    expect(noPlain.map((model) => model.id)).toContain("beam-free");
    const noAnthropic = await fetchCatalog(PROXY, proxyFetch({ plain: PLAIN, anthropicStatus: 500 }).fetcher, AbortSignal.timeout(1000));
    expect(noAnthropic.map((model) => model.id)).toContain("beam-free");
    expect(byId(noAnthropic)["beam-free"]?.name).toBe("beam-free");
  });

  it("throws, with the statuses, when neither list is usable", async () => {
    await expect(fetchCatalog(PROXY, proxyFetch({ plainStatus: 401, anthropicStatus: 401 }).fetcher, AbortSignal.timeout(1000))).rejects.toThrow(/HTTP 401.*HTTP 401/);
    await expect(fetchCatalog(PROXY, proxyFetch({ plain: { data: [] }, anthropic: { data: [] } }).fetcher, AbortSignal.timeout(1000))).rejects.toThrow(/no models/);
  });
});

const memoryStore = (initial?: unknown) => {
  let value: unknown = initial;
  const writes: Array<Catalog> = [];
  return { store: { read: () => value, write: (catalog: Catalog) => { value = catalog; writes.push(catalog); } }, writes };
};

describe("the kept catalog", () => {
  it("is the static list before the proxy's was ever read, and is read then", async () => {
    const { store, writes } = memoryStore();
    const clock = { at: 1_000 };
    const catalog = modelCatalog({ store, proxy: PROXY, now: () => clock.at, fetcher: proxyFetch({ plain: PLAIN, anthropic: ANTHROPIC }).fetcher });
    expect(catalog.current()).toBe(STATIC_CATALOG);
    expect(catalog.find(DEFAULT_MODEL_SLUG)).toBeDefined();
    expect(await catalog.refresh()).toEqual({ status: "fetched", models: 5 });
    expect(catalog.current().fetchedAt).toBe(1_000);
    expect(catalog.find("anthropic/gemini-3-flash")?.name).toBe("Gemini 3 Flash");
    expect(catalog.find(DEFAULT_MODEL_SLUG)).toBeUndefined();
    expect(writes).toHaveLength(1);
  });

  it("reads again only when old, or when forced", async () => {
    const { store } = memoryStore();
    const clock = { at: 0 };
    const answers = proxyFetch({ plain: PLAIN, anthropic: ANTHROPIC });
    const catalog = modelCatalog({ store, proxy: PROXY, now: () => clock.at, fetcher: answers.fetcher });
    await catalog.refresh();
    const reads = () => answers.calls.length;
    const first = reads();
    clock.at = CATALOG_TTL_MS - 1;
    expect(await catalog.refresh()).toEqual({ status: "fresh" });
    expect(reads()).toBe(first);
    expect((await catalog.refresh({ force: true })).status).toBe("fetched");
    expect(reads()).toBe(first * 2);
    clock.at += CATALOG_TTL_MS;
    expect((await catalog.refresh()).status).toBe("fetched");
  });

  it("keeps the copy it has when a read fails, and waits before trying again, a forced one too", async () => {
    const clock = { at: 0 };
    const good = proxyFetch({ plain: PLAIN, anthropic: ANTHROPIC });
    const bad = proxyFetch({ plainStatus: 503, anthropicStatus: 503 });
    let fetcher = good.fetcher;
    const { store } = memoryStore();
    const catalog = modelCatalog({ store, proxy: PROXY, now: () => clock.at, fetcher: (...args) => fetcher(...args) });
    await catalog.refresh();
    const kept = catalog.current();
    fetcher = bad.fetcher;
    clock.at = CATALOG_TTL_MS + 1;
    expect((await catalog.refresh()).status).toBe("failed");
    expect(catalog.current()).toBe(kept);
    const attempts = bad.calls.length;
    clock.at += CATALOG_RETRY_MS - 1;
    expect(await catalog.refresh({ force: true })).toEqual({ status: "fresh" });
    expect(bad.calls.length).toBe(attempts);
    clock.at += 2;
    fetcher = good.fetcher;
    expect((await catalog.refresh()).status).toBe("fetched");
  });

  it("joins a read in flight, and reads nothing without a proxy", async () => {
    const answers = proxyFetch({ plain: PLAIN, anthropic: ANTHROPIC });
    const catalog = modelCatalog({ store: memoryStore().store, proxy: PROXY, fetcher: answers.fetcher });
    const [a, b] = await Promise.all([catalog.refresh(), catalog.refresh()]);
    expect(a).toBe(b);
    expect(answers.calls).toHaveLength(2);
    const none = modelCatalog({ store: memoryStore().store, proxy: undefined, fetcher: answers.fetcher });
    expect(await none.refresh({ force: true })).toEqual({ status: "fresh" });
    expect(none.current()).toBe(STATIC_CATALOG);
  });

  it("uses the copy a restart finds in storage, and ignores one of another shape", () => {
    const kept = { models: mergeLists(parseList(PLAIN)?.models, parseList(ANTHROPIC)?.models), fetchedAt: 5 };
    expect(isCatalog(kept)).toBe(true);
    expect(modelCatalog({ store: memoryStore(kept).store, proxy: PROXY }).current()).toEqual(kept);
    for (const wrong of [undefined, null, { models: [{ id: "x" }], fetchedAt: 1 }, { models: [], fetchedAt: 1 }, "x"]) {
      expect(modelCatalog({ store: memoryStore(wrong).store, proxy: PROXY }).current()).toBe(STATIC_CATALOG);
    }
  });
});

describe("the provider snapshot's models", () => {
  const dynamic: Catalog = { models: mergeLists(parseList(PLAIN)?.models, parseList(ANTHROPIC)?.models), fetchedAt: 1 };

  it("lists the catalog, grouped by who serves each model, with a thinking picker for the models that think", () => {
    const models = snapshotModels(dynamic);
    expect(models.map((model) => model.slug)).toEqual(dynamic.models.map((model) => model.slug));
    const gemini = models.find((model) => model.slug === "anthropic/gemini-3-flash");
    expect(gemini).toMatchObject({ name: "Gemini 3 Flash", subProvider: "antigravity", isCustom: false });
    expect(gemini?.capabilities?.optionDescriptors ?? []).toHaveLength(0);
    const haiku = models.find((model) => model.slug === "anthropic/claude-haiku-5-5");
    expect(haiku?.capabilities?.optionDescriptors?.map((option) => option.id)).toEqual(["thinking"]);
  });

  it("makes the default model the picker's default, or the first model when the catalog lacks it", () => {
    expect(snapshotModels(STATIC_CATALOG).filter((model) => model.isDefault).map((model) => model.slug)).toEqual([DEFAULT_MODEL_SLUG]);
    expect(snapshotModels(dynamic).filter((model) => model.isDefault).map((model) => model.slug)).toEqual(["anthropic/beam-free"]);
  });
});
