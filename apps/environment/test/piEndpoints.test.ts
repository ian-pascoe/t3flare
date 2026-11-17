// SPI-1170: pi's Model endpoints (`provider/cli/piEndpoints.ts`): which endpoints pi gets, its model list, the model it
// starts on, and the mapping of t3's slugs to pi's provider ids on the process's RPC lines.
import type { EndpointApi, ModelEndpoints } from "@t3flare/models/endpoints";
import { endpointIdOfProvider, endpointProviderId } from "@t3flare/models/relay";
import { describe, expect, it } from "vitest";

import { lineMapper, piEndpoints, piLineFromPi, piLineToPi, piModelsOf, piRelayOf } from "../src/provider/cli/piEndpoints.ts";

const model = (id: string, reasoning = false) => ({ id, name: `${id} name`, reasoning, input: ["text" as const], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false });
const endpoint = (id: string, api: EndpointApi, models: ReadonlyArray<ReturnType<typeof model>>, label = id) => ({ id, label, api, baseUrl: `https://${id}.example`, auth: "api-key" as const, headers: {}, models });
const endpoints = (...list: ReadonlyArray<ReturnType<typeof endpoint>>): ModelEndpoints => ({ revision: 1, endpoints: list });

describe("pi's endpoints", () => {
  it("are every endpoint that lists a model, of any API, in the owner's order", () => {
    const all = endpoints(endpoint("gem", "google-generative-ai", [model("g")]), endpoint("empty", "anthropic-messages", []), endpoint("comm", "anthropic-messages", [model("c")]), endpoint("mis", "mistral-conversations", [model("m")]));
    expect(piEndpoints(all).map((entry) => entry.id)).toEqual(["gem", "comm", "mis"]);
    expect(piEndpoints(undefined)).toEqual([]);
  });

  it("put pi on the relay only when one lists a model, starting on the first endpoint's first model", () => {
    expect(piRelayOf(endpoints(endpoint("empty", "openai-responses", [])))).toBeUndefined();
    expect(piRelayOf(undefined)).toBeUndefined();
    const relay = piRelayOf(endpoints(endpoint("empty", "openai-responses", []), endpoint("oai", "openai-completions", [model("gpt-x"), model("gpt-y")]), endpoint("comm", "anthropic-messages", [model("c")])));
    expect(relay?.endpoints.map((entry) => entry.id)).toEqual(["oai", "comm"]);
    expect(relay?.model).toBe("oai/gpt-x");
  });
});

describe("pi's endpoints and sign-ins", () => {
  it("takes every sign-in through the relay (SPI-1171): ChatGPT, Claude and GitHub Copilot", () => {
    const chatgpt = { ...endpoint("chatgpt", "openai-responses", [model("gpt-6.1-sol")]), auth: "chatgpt" as const };
    const claude = { ...endpoint("claude", "anthropic-messages", [model("claude-haiku-5-5")]), auth: "claude" as const };
    const copilot = { ...endpoint("copilot", "openai-responses", [model("gpt-6.1-sol")]), auth: "copilot" as const };
    expect(piEndpoints({ revision: 1, endpoints: [chatgpt] }).map((entry) => entry.id)).toEqual(["chatgpt"]);
    expect(piRelayOf({ revision: 1, endpoints: [chatgpt] })?.model).toBe("chatgpt/gpt-6.1-sol");
    expect(piModelsOf({ revision: 1, endpoints: [chatgpt] }).map((entry) => entry.slug)).toEqual(["chatgpt/gpt-6.1-sol"]);
    const both = endpoints(endpoint("comm", "anthropic-messages", [model("c")]));
    expect(piRelayOf({ revision: 1, endpoints: [chatgpt, claude, copilot, ...both.endpoints] })?.endpoints.map((entry) => entry.id)).toEqual(["chatgpt", "claude", "copilot", "comm"]);
  });
});

describe("pi's start model", () => {
  it("is the picker's default row: the first endpoint that lists a model's first model", () => {
    const list = endpoints(endpoint("empty", "openai-responses", []), endpoint("comm", "anthropic-messages", [model("c"), model("d")]), endpoint("oai", "openai-completions", [model("x")]));
    const picked = piModelsOf(list).find((row) => row.isDefault === true)?.slug;
    expect(picked).toBe("comm/c");
    expect(piRelayOf(list)?.model).toBe(picked);
  });
});

describe("pi's model list", () => {
  it("is the endpoints' models by slug, grouped by endpoint, the first the default, with pi's thinking picker on reasoning models", () => {
    const list = piModelsOf(endpoints(endpoint("oai", "openai-completions", [model("gpt-x"), model("o-think", true)], "Gateway"), endpoint("comm", "anthropic-messages", [model("c")], "Gateway"), endpoint("empty", "openai-responses", [])));
    expect(list.map((entry) => [entry.slug, entry.subProvider, entry.isDefault === true])).toEqual([
      ["oai/gpt-x", "Gateway · oai", true],
      ["oai/o-think", "Gateway · oai", false],
      ["comm/c", "Gateway · comm", false],
    ]);
    expect(list[1]!.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual(["thinking"]);
    expect(list[0]!.capabilities?.optionDescriptors).toEqual([]);
    // No proxy model alongside them (the choice is the Environment's).
    expect(list.some((entry) => entry.slug.startsWith("anthropic/"))).toBe(false);
  });

  it("is empty without such an endpoint: there is no other catalog to fall back to (SPI-1176)", () => {
    expect(piModelsOf(endpoints(endpoint("empty", "anthropic-messages", [])))).toEqual([]);
    expect(piModelsOf(undefined)).toEqual([]);
  });
});

describe("endpointIdOfProvider", () => {
  it("inverts endpointProviderId, and names no endpoint for any other provider id", () => {
    expect(endpointIdOfProvider(endpointProviderId("oai"))).toBe("oai");
    expect(endpointIdOfProvider(endpointProviderId("t3flare-endpoint-x"))).toBe("t3flare-endpoint-x");
    for (const id of ["anthropic", "t3flare-endpoint-", "t3flare-endpoin-oai", ""]) expect(endpointIdOfProvider(id), id).toBeUndefined();
  });
});

describe("pi's RPC lines on the relay", () => {
  const ids = new Set(["oai", "comm", "t3flare-endpoint-x"]);

  it("names an endpoint's pi provider in a set_model of t3's, by the endpoint's id", () => {
    expect(JSON.parse(piLineToPi('{"id":"c3","type":"set_model","provider":"oai","modelId":"org/model:free"}', ids))).toEqual({ id: "c3", type: "set_model", provider: "t3flare-endpoint-oai", modelId: "org/model:free" });
    // An endpoint whose own id looks like a provider id is still mapped by its id.
    expect(JSON.parse(piLineToPi('{"type":"set_model","provider":"t3flare-endpoint-x","modelId":"m"}', ids)).provider).toBe("t3flare-endpoint-t3flare-endpoint-x");
  });

  it("names the default model in place of an old thread's `anthropic` (an old thread's, SPI-1176)", () => {
    expect(JSON.parse(piLineToPi('{"id":"c4","type":"set_model","provider":"anthropic","modelId":"claude-sonnet-5-5"}', ids, "comm/c"))).toEqual({
      id: "c4",
      type: "set_model",
      provider: "t3flare-endpoint-comm",
      modelId: "c",
    });
    // Given as a function of the old model id: the endpoint that lists it (`retiredSelectionSlug`), else the default.
    const sameId = (modelId: string) => (modelId === "claude-sonnet-5-5" ? "comm/claude-sonnet-5-5" : "comm/c");
    expect(JSON.parse(piLineToPi('{"type":"set_model","provider":"anthropic","modelId":"claude-sonnet-5-5"}', ids, sameId))).toMatchObject({ provider: "t3flare-endpoint-comm", modelId: "claude-sonnet-5-5" });
    expect(JSON.parse(piLineToPi('{"type":"set_model","provider":"anthropic","modelId":"claude-x"}', ids, sameId))).toMatchObject({ provider: "t3flare-endpoint-comm", modelId: "c" });
    // A default that is no endpoint of the process's names nothing in its place.
    const line = '{"type":"set_model","provider":"anthropic","modelId":"claude-sonnet-5-5"}';
    expect(piLineToPi(line, ids, "gone/m")).toBe(line);
  });

  it("passes every other line as it is: another command, another provider, a prompt naming set_model, not JSON", () => {
    for (const line of [
      '{"type":"prompt","message":"call set_model with provider oai"}',
      '{"type":"set_model","provider":"anthropic","modelId":"claude-sonnet-5-5"}',
      '{"type":"set_model","provider":"t3flare-endpoint-oai","modelId":"gpt-x"}',
      '{"type":"set_model","modelId":"gpt-x"}',
      '"set_model"',
      'not json "set_model"',
      "",
    ]) {
      expect(piLineToPi(line, ids)).toBe(line);
    }
  });

  it("names an endpoint's model by the endpoint's id where pi puts the model's provider: each model command's response and an assistant message's end", () => {
    const models = { type: "response", id: "c1", command: "get_available_models", success: true, data: { models: [{ provider: "t3flare-endpoint-oai", id: "gpt-x", contextWindow: 5 }, { provider: "anthropic", id: "claude" }, { provider: "t3flare-endpoint-gone", id: "m" }] } };
    expect(JSON.parse(piLineFromPi(JSON.stringify(models), ids)).data.models.map((entry: { provider: string }) => entry.provider)).toEqual(["oai", "anthropic", "t3flare-endpoint-gone"]);
    for (const command of ["get_state", "cycle_model"]) {
      const state = { type: "response", command, success: true, data: { model: { provider: "t3flare-endpoint-comm", id: "c" }, sessionFile: "/x" } };
      expect(JSON.parse(piLineFromPi(JSON.stringify(state), ids)).data, command).toEqual({ model: { provider: "comm", id: "c" }, sessionFile: "/x" });
    }
    const set = { type: "response", command: "set_model", success: true, data: { provider: "t3flare-endpoint-oai", id: "gpt-x", baseUrl: "http://computer.internal/t3flare/model/oai" } };
    expect(JSON.parse(piLineFromPi(JSON.stringify(set), ids)).data).toEqual({ ...set.data, provider: "oai" });
    const end = { type: "message_end", message: { role: "assistant", provider: "t3flare-endpoint-t3flare-endpoint-x", model: "m", content: [{ type: "text", text: 'a "provider":"t3flare-endpoint-oai" in text' }] } };
    const mapped = JSON.parse(piLineFromPi(JSON.stringify(end), ids));
    expect(mapped.message.provider).toBe("t3flare-endpoint-x");
    expect(mapped.message.content[0].text).toBe('a "provider":"t3flare-endpoint-oai" in text');
  });

  it("changes no other member: a tool call's arguments, another response's data, nested providers", () => {
    const end = { type: "message_end", message: { role: "assistant", provider: "t3flare-endpoint-oai", model: "m", content: [{ type: "toolCall", name: "bash", arguments: { provider: "t3flare-endpoint-oai", nested: { provider: "t3flare-endpoint-comm" } } }] } };
    expect(JSON.parse(piLineFromPi(JSON.stringify(end), ids)).message.content).toEqual(end.message.content);
    const other = { type: "response", command: "bash", success: true, data: { provider: "t3flare-endpoint-oai", output: "x" } };
    expect(piLineFromPi(JSON.stringify(other), ids)).toBe(JSON.stringify(other));
    const state = { type: "response", command: "get_state", success: true, data: { model: { provider: "t3flare-endpoint-comm" }, extra: { provider: "t3flare-endpoint-comm" } } };
    expect(JSON.parse(piLineFromPi(JSON.stringify(state), ids)).data.extra).toEqual({ provider: "t3flare-endpoint-comm" });
  });

  it("leaves other lines unparsed and unchanged", () => {
    for (const line of [
      '{"type":"message_update","message":{"provider":"t3flare-endpoint-oai"}}',
      '{"type":"response","command":"get_state","data":{"model":{"provider":"anthropic"}}}',
      '{"type":"turn_end","note":"\\"type\\":\\"response\\" t3flare-endpoint-oai"}',
      'not json "type":"response" t3flare-endpoint-oai',
    ]) {
      expect(piLineFromPi(line, ids)).toBe(line);
    }
  });

  it("maps whole lines of a byte stream, holding a cut line until its newline or the end", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const mapper = lineMapper((line) => line.toUpperCase());
    expect(decode(mapper.chunk(encode("ab")))).toBe("");
    expect(decode(mapper.chunk(encode("c\nde\nf")))).toBe("ABC\nDE\n");
    // A multi-byte character cut between two chunks.
    const euro = encode("€");
    expect(decode(mapper.chunk(euro.slice(0, 1)))).toBe("");
    expect(decode(mapper.chunk(Uint8Array.of(...euro.slice(1), 10)))).toBe("F€\n");
    expect(decode(mapper.chunk(encode("tail")))).toBe("");
    expect(decode(mapper.flush())).toBe("TAIL");
    expect(decode(mapper.flush())).toBe("");
  });
});
