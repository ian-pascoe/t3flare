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
import { endpointSlug, type ModelEndpoint, type ModelEndpoints } from "@t3flare/models/endpoints";
import { endpointProviderId } from "@t3flare/models/relay";

import type { PiRelay } from "../../agents/cliProfiles.ts";
import { snapshotModels } from "../models.ts";

/** The endpoints pi reaches through the model relay: every endpoint that lists a model (pi speaks each API). */
export const piEndpoints = (endpoints: ModelEndpoints | undefined): ReadonlyArray<ModelEndpoint> => (endpoints?.endpoints ?? []).filter((endpoint) => endpoint.models.length > 0);

/** pi's relay configuration for the endpoints as stored now, or undefined for the Model proxy (no endpoint lists a model). */
export const piRelayOf = (endpoints: ModelEndpoints | undefined): PiRelay | undefined => {
  const own = piEndpoints(endpoints);
  if (own.length === 0) return undefined;
  // The picker's default (`piModelsOf`'s first).
  return { endpoints: own, model: endpointSlug(own[0]!.id, own[0]!.models[0]!.id) };
};

/**
 * pi's model list: with an endpoint that lists a model, those endpoints' models by slug, grouped by endpoint, each with
 * pi's thinking picker on reasoning models, the first the default; else the proxy's catalog, as before.
 */
export const piModelsOf = (catalog: Catalog, endpoints: ModelEndpoints | undefined): ReadonlyArray<ServerProviderModel> => {
  const own = piEndpoints(endpoints);
  return own.length === 0 ? snapshotModels(catalog) : snapshotModels({ models: [], fetchedAt: null }, { revision: 0, endpoints: own });
};

const PROVIDER_PREFIX = endpointProviderId("");

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

/** Every `provider` member in `value` that names an endpoint's pi provider, named by its endpoint id instead. */
const endpointIdsIn = (value: unknown, endpointIds: ReadonlySet<string>): unknown => {
  if (Array.isArray(value)) return value.map((entry) => endpointIdsIn(entry, endpointIds));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key === "provider" && typeof entry === "string" && entry.startsWith(PROVIDER_PREFIX) && endpointIds.has(entry.slice(PROVIDER_PREFIX.length))) {
        return [key, entry.slice(PROVIDER_PREFIX.length)];
      }
      return [key, endpointIdsIn(entry, endpointIds)];
    }),
  );
};

/**
 * A line pi sends t3's Pi adapter: in a command's response (`get_available_models`, `get_state`, `set_model`, …) and an
 * assistant message's end, the only lines where the adapter reads a provider, an endpoint's pi provider is named by its
 * endpoint id, so the adapter's `<provider>/<model>` is t3's slug. Every other line passes as it is (unparsed).
 */
export const piLineFromPi = (line: string, endpointIds: ReadonlySet<string>): string => {
  if (!line.includes(PROVIDER_PREFIX) || !(line.includes('"type":"response"') || line.includes('"type":"message_end"'))) return line;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return line;
  }
  if (typeof event !== "object" || event === null) return line;
  const type = (event as { type?: unknown }).type;
  if (type !== "response" && type !== "message_end") return line;
  return JSON.stringify(endpointIdsIn(event, endpointIds));
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
