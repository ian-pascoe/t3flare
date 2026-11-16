// pi's Model endpoints (SPI-1170): pi speaks every endpoint API (it is pi-ai's coding agent, and an endpoint's API is
// one pi-ai speaks), so every endpoint that lists a model is pi's. With one, pi runs on them through the model relay,
// not the Model proxy: one pi provider per endpoint (`t3flare-endpoint-<id>`, prefixed so no endpoint id changes one of
// pi's built-in providers) at the relay's per-endpoint URL, so a model switch between two endpoints, across APIs, stays
// in the thread's process. The choice is the Environment's, as Claude Code's and OpenCode's (SPI-1168, SPI-1169): with
// such an endpoint every pi process runs on the endpoints, and the Model proxy's models are not offered. Pure.
//
// t3's slugs stay `<endpointId>/<modelId>`. t3's Pi adapter names a model to pi by its `{ provider, modelId }` (RPC
// `set_model`) and reads pi's own back (`get_available_models`, `get_state`, an assistant message's `provider`), so the
// process's RPC lines are mapped at the channel: an endpoint id to its provider on the way in, a provider to its
// endpoint id on the way out. pi's session files keep its own provider ids, which follow from the endpoint's id (which
// never changes), so a session resumes in a new process.
import type { ServerProviderModel } from "@t3tools/contracts";
import type { Catalog } from "@t3flare/models/catalog";
import { type ModelEndpoint, type ModelEndpoints } from "@t3flare/models/endpoints";
import { endpointIdOfProvider, endpointProviderId } from "@t3flare/models/relay";

import type { PiRelay } from "../../agents/cliProfiles.ts";
import { snapshotModels } from "../models.ts";

/**
 * Whether pi reaches an endpoint through the model relay: it lists a model (pi speaks every endpoint API). The one
 * place a further rule goes (a sign-in endpoint's, SPI-1164).
 */
export const piServes = (endpoint: ModelEndpoint): boolean => endpoint.models.length > 0;

/** The endpoints pi reaches through the model relay, in the owner's order. */
export const piEndpoints = (endpoints: ModelEndpoints | undefined): ReadonlyArray<ModelEndpoint> => (endpoints?.endpoints ?? []).filter(piServes);

/** The picker's rows of pi's endpoints: by slug, grouped by endpoint, pi's thinking picker on reasoning models, the first the default. */
const pickerOf = (own: ReadonlyArray<ModelEndpoint>): ReadonlyArray<ServerProviderModel> => snapshotModels({ models: [], fetchedAt: null }, { revision: 0, endpoints: own });

/**
 * pi's relay configuration for the endpoints as stored now (each one pi serves, so each lists a model), or undefined for
 * the Model proxy (none does). pi starts on the picker's default.
 */
export const piRelayOf = (endpoints: ModelEndpoints | undefined): PiRelay | undefined => {
  const own = piEndpoints(endpoints);
  if (own.length === 0) return undefined;
  return { endpoints: own, model: pickerOf(own).find((row) => row.isDefault === true)?.slug };
};

/** pi's model list: with an endpoint pi serves, those endpoints' models (`pickerOf`); else the proxy's catalog, as before. */
export const piModelsOf = (catalog: Catalog, endpoints: ModelEndpoints | undefined): ReadonlyArray<ServerProviderModel> => {
  const own = piEndpoints(endpoints);
  return own.length === 0 ? snapshotModels(catalog) : pickerOf(own);
};

/**
 * A line t3's Pi adapter sends pi (one RPC command): a `set_model` naming an endpoint id as its provider names that
 * endpoint's pi provider instead. Every other line, and a provider that is no endpoint's of the process (a built-in, a
 * stale proxy model's `anthropic`), passes as it is.
 */
export const piLineToPi = (line: string, endpointIds: ReadonlySet<string>): string => {
  if (!line.includes('"set_model"')) return line;
  let command: unknown;
  try {
    command = JSON.parse(line);
  } catch {
    return line;
  }
  if (typeof command !== "object" || command === null || (command as { type?: unknown }).type !== "set_model") return line;
  const provider = (command as { provider?: unknown }).provider;
  if (typeof provider !== "string" || !endpointIds.has(provider)) return line;
  return JSON.stringify({ ...command, provider: endpointProviderId(provider) });
};

/** Every endpoint provider id starts so: a line without it holds none (a cheap test before any parse). */
const PROVIDER_PREFIX = endpointProviderId("");

/** `provider` as t3 names it: an endpoint's pi provider as its endpoint id; any other provider as it is. */
const asEndpointId = (provider: unknown, endpointIds: ReadonlySet<string>): unknown => {
  const endpointId = typeof provider === "string" ? endpointIdOfProvider(provider) : undefined;
  return endpointId !== undefined && endpointIds.has(endpointId) ? endpointId : provider;
};

/** A pi Model object (or anything else) with its `provider` as t3 names it. */
const withEndpointId = (model: unknown, endpointIds: ReadonlySet<string>): unknown =>
  typeof model === "object" && model !== null && !Array.isArray(model) && "provider" in model ? { ...model, provider: asEndpointId((model as { provider: unknown }).provider, endpointIds) } : model;

type Line = { readonly type?: unknown; readonly command?: unknown; readonly data?: unknown; readonly message?: unknown };

/**
 * A line pi sends t3's Pi adapter, with the model's provider named as t3 names it where pi puts one and t3's adapter
 * reads it: `set_model`'s response (a Model), `get_state`'s and `cycle_model`'s (`data.model`),
 * `get_available_models`'s (`data.models[]`), and `message_end` (`message.provider`). Nothing else in a line changes
 * (a tool call's arguments that name a provider stay as they are). Every other line passes as it is (unparsed).
 */
export const piLineFromPi = (line: string, endpointIds: ReadonlySet<string>): string => {
  if (!line.includes(PROVIDER_PREFIX) || !(line.includes('"type":"response"') || line.includes('"type":"message_end"'))) return line;
  let event: Line;
  try {
    event = JSON.parse(line) as Line;
  } catch {
    return line;
  }
  if (typeof event !== "object" || event === null) return line;
  const data = event.data as { readonly model?: unknown; readonly models?: unknown } | null | undefined;
  if (event.type === "message_end") return JSON.stringify({ ...event, message: withEndpointId(event.message, endpointIds) });
  if (event.type !== "response" || typeof data !== "object" || data === null) return line;
  switch (event.command) {
    case "set_model":
      return JSON.stringify({ ...event, data: withEndpointId(data, endpointIds) });
    case "get_state":
    case "cycle_model":
      return JSON.stringify({ ...event, data: { ...data, model: withEndpointId(data.model, endpointIds) } });
    case "get_available_models":
      return Array.isArray(data.models) ? JSON.stringify({ ...event, data: { ...data, models: data.models.map((model: unknown) => withEndpointId(model, endpointIds)) } }) : line;
    default:
      return line;
  }
};

/**
 * A byte stream's lines, each mapped (`map` gets a line without its newline). A last line without a newline is held
 * until `flush`, at the stream's end. Stateful: one per stream.
 */
export const lineMapper = (map: (line: string) => string) => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return {
    chunk: (bytes: Uint8Array): Uint8Array => {
      pending += decoder.decode(bytes, { stream: true });
      const end = pending.lastIndexOf("\n");
      if (end === -1) return new Uint8Array(0);
      const lines = pending.slice(0, end).split("\n");
      pending = pending.slice(end + 1);
      return encoder.encode(`${lines.map(map).join("\n")}\n`);
    },
    flush: (): Uint8Array => {
      const rest = pending + decoder.decode();
      pending = "";
      return encoder.encode(rest === "" ? "" : map(rest));
    },
  };
};
