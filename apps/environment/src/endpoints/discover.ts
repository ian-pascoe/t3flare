// @effect-diagnostics extendsNativeError:off
// A Model endpoint's model list (SPI-1162), read from the endpoint for the panel's form: Anthropic's paged `/v1/models`
// (with `x-api-key`), the OpenAI-shaped `/models` (a bearer key; OpenAI, OpenRouter, Mistral, most compatible servers),
// and Google's `/models` (`x-goog-api-key`, the models that generate content). The owner picks from it; pi-ai's catalog
// fills in what the list does not say (store.ts). A failure is reported as its HTTP status, never its body (which may
// echo the key).
import { parseList, realIdOf } from "@t3flare/models/catalog";
import { type EndpointModelInput, type EndpointTarget, isRecord } from "@t3flare/models/endpoints";
import { credentialHeaderOf } from "@t3flare/models/relay";

const TIMEOUT_MS = 10_000;
const MAX_PAGES = 10;

export type Discovery = { readonly ok: true; readonly models: ReadonlyArray<EndpointModelInput> } | { readonly ok: false; readonly error: string };

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

class ListError extends Error {}

/** The endpoint's own headers, then the key in the header its API takes (`credentialHeaderOf`; none without a key). */
const keyedHeaders = (target: EndpointTarget, apiKey: string | undefined): Record<string, string> => {
  if (apiKey === undefined) return { ...target.headers };
  const credential = credentialHeaderOf(target.api, apiKey);
  return { ...target.headers, [credential.name]: credential.value };
};

const getJson = async (url: URL, headers: Record<string, string>, fetcher: typeof fetch, signal: AbortSignal): Promise<unknown> => {
  // Never followed: a redirect would carry the key to wherever it points.
  const response = await fetcher(url, { headers: { accept: "application/json", ...headers }, signal, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw new ListError(`the endpoint's model list redirected (HTTP ${response.status}): give the base URL it redirects to`);
  if (!response.ok) throw new ListError(`the endpoint's model list answered HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new ListError("the endpoint's model list is not JSON");
  }
};

const anthropic = async (target: EndpointTarget, apiKey: string | undefined, fetcher: typeof fetch, signal: AbortSignal) => {
  const headers = { ...keyedHeaders(target, apiKey), "anthropic-version": "2023-06-01" };
  const models: Array<EndpointModelInput> = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${target.baseUrl}/v1/models`);
    url.searchParams.set("limit", "1000");
    if (after !== undefined) url.searchParams.set("after_id", after);
    const listed = parseList(await getJson(url, headers, fetcher, signal));
    if (listed === undefined) throw new ListError("the endpoint's answer is not a list of models");
    for (const model of listed.models) {
      models.push({
        // A Model proxy that lists a non-Claude model under an alias (Commissary) is read back to its real id.
        id: realIdOf(model.id),
        ...(model.displayName === undefined ? {} : { name: model.displayName }),
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      });
    }
    if (listed.lastId === undefined) break;
    after = listed.lastId;
  }
  return models;
};

const openai = async (target: EndpointTarget, apiKey: string | undefined, fetcher: typeof fetch, signal: AbortSignal) => {
  const body = await getJson(new URL(`${target.baseUrl}/models`), keyedHeaders(target, apiKey), fetcher, signal);
  if (!isRecord(body) || !Array.isArray(body.data)) throw new ListError("the endpoint's answer is not a list of models");
  return body.data.flatMap((entry): Array<EndpointModelInput> => (isRecord(entry) && typeof entry.id === "string" && entry.id !== "" ? [{ id: entry.id }] : []));
};

const google = async (target: EndpointTarget, apiKey: string | undefined, fetcher: typeof fetch, signal: AbortSignal) => {
  const url = new URL(`${target.baseUrl}/models`);
  url.searchParams.set("pageSize", "1000");
  const body = await getJson(url, keyedHeaders(target, apiKey), fetcher, signal);
  if (!isRecord(body) || !Array.isArray(body.models)) throw new ListError("the endpoint's answer is not a list of models");
  return body.models.flatMap((entry): Array<EndpointModelInput> => {
    if (!isRecord(entry) || typeof entry.name !== "string") return [];
    const methods = Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : [];
    if (!methods.includes("generateContent")) return [];
    const contextWindow = count(entry.inputTokenLimit);
    const maxTokens = count(entry.outputTokenLimit);
    return [
      {
        id: entry.name.replace(/^models\//, ""),
        ...(typeof entry.displayName === "string" && entry.displayName !== "" ? { name: entry.displayName } : {}),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      },
    ];
  });
};

/** The models `target` lists, sorted by id, read with `apiKey` (none for an endpoint without auth). */
export const discoverModels = async (target: EndpointTarget, apiKey: string | undefined, fetcher: typeof fetch = fetch): Promise<Discovery> => {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const read = target.api === "anthropic-messages" ? anthropic : target.api === "google-generative-ai" ? google : openai;
    const models = await read(target, apiKey, fetcher, signal);
    const unique = [...new Map(models.map((model) => [model.id, model])).values()].sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, models: unique };
  } catch (error) {
    if (error instanceof ListError) return { ok: false, error: error.message };
    const name = error instanceof Error ? error.name : "";
    return { ok: false, error: name === "TimeoutError" ? "the endpoint's model list did not answer in 10 s" : "the endpoint's model list could not be reached" };
  }
};
