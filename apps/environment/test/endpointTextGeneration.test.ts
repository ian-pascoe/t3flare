// Pi Durable's text generation on Model endpoints (SPI-1163): an `<endpointId>/<modelId>` selection runs as one request on
// the agents Worker (`TEXT_GENERATION`), with the endpoint as stored now and no key; `default` is a small model of the
// first endpoint that has one; the Model proxy's `anthropic/…` models keep their own path until the hard cut. Every
// failure names the endpoint.
import { ProviderInstanceId } from "@t3tools/contracts";
import type { EndpointModel, EndpointTextAnswer, EndpointTextRequest, ModelEndpoint, ModelEndpoints } from "@t3flare/models/endpoints";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { runText } from "../src/provider/textGeneration.ts";

const COST = { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 };
const model = (id: string): EndpointModel => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 8_000, cost: COST, known: true });
const OPENAI: ModelEndpoint = {
  id: "openai",
  label: "OpenAI",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  auth: "api-key",
  headers: {},
  models: [model("gpt-5.4"), model("gpt-5-mini")],
};
const BIG: ModelEndpoint = { ...OPENAI, id: "big", label: "Big", models: [model("gpt-5.4")] };
const ENDPOINTS: ModelEndpoints = { revision: 4, endpoints: [BIG, OPENAI] };

const bind = (answer: (request: EndpointTextRequest) => EndpointTextAnswer | Promise<EndpointTextAnswer>, options: { readonly bound?: boolean; readonly proxy?: boolean } = {}) => {
  const calls: Array<EndpointTextRequest> = [];
  bindEnvironmentServices({
    agents: options.bound === false ? {} : { TEXT_GENERATION: { generate: async (request: EndpointTextRequest) => (calls.push(request), answer(request)) } },
    modelProxy: options.proxy === false ? undefined : { url: "https://proxy.example", apiKey: "proxy-key" },
    modelEndpoints: () => ENDPOINTS,
  } as unknown as EnvironmentServices);
  return calls;
};

const run = (model: string) =>
  Effect.runPromise(
    Effect.exit(
      runText({
        operation: "generateThreadTitle",
        cwd: "/w/x",
        prompt: "Name this thread.",
        outputSchema: Schema.Struct({ title: Schema.String }),
        modelSelection: { instanceId: ProviderInstanceId.make("piDurable"), model },
      }),
    ),
  );

const detailOf = (exit: Exit.Exit<unknown, { readonly detail: string }>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  return (failure as unknown as { readonly error: { readonly detail: string } }).error.detail;
};

afterEach(() => vi.unstubAllGlobals());

describe("runText on Model endpoints", () => {
  it("runs an endpoint's model on the agents Worker with the endpoint as stored now, and no key", async () => {
    const calls = bind(() => ({ ok: true, text: '{"title":"Fix the build"}' }));
    const exit = await run("openai/gpt-5-mini");
    expect(exit).toEqual(Exit.succeed({ title: "Fix the build" }));
    expect(calls).toEqual([{ endpoint: OPENAI, modelId: "gpt-5-mini", prompt: "Name this thread." }]);
    expect(JSON.stringify(calls)).not.toContain("proxy-key");
  });

  it("runs `default` on a small model of the first endpoint that has one", async () => {
    const calls = bind(() => ({ ok: true, text: '{"title":"t"}' }));
    await run("default");
    expect(calls.map((call) => `${call.endpoint.id}/${call.modelId}`)).toEqual(["openai/gpt-5-mini"]);
  });

  it("passes the agents Worker's failure on, naming the endpoint", async () => {
    bind(() => ({ ok: false, error: 'The Model endpoint "openai" refused its API key (HTTP 401): check it in the Harness panel.' }));
    expect(detailOf(await run("openai/gpt-5-mini"))).toBe('The Model endpoint "openai" refused its API key (HTTP 401): check it in the Harness panel.');
  });

  it("names the endpoint when the agents Worker cannot be reached, without its error's text", async () => {
    bind(() => Promise.reject(new Error("internal error; reference = 0123")));
    expect(detailOf(await run("openai/gpt-5-mini"))).toBe('Text generation on the Model endpoint "openai" failed: the agents Worker could not be reached.');
  });

  it("says when the endpoint no longer lists the model, or is gone, and calls nothing", async () => {
    const calls = bind(() => ({ ok: true, text: "{}" }));
    expect(detailOf(await run("openai/gpt-4"))).toBe('The Model endpoint "openai" no longer lists the model gpt-4: pick another model for text generation.');
    expect(detailOf(await run("gone/gpt-5-mini"))).toBe('The Model endpoint "gone" was removed: pick another model for text generation.');
    expect(calls).toEqual([]);
  });

  it("says when the Environment has no text generation binding", async () => {
    bind(() => ({ ok: true, text: "{}" }), { bound: false });
    expect(detailOf(await run("openai/gpt-5-mini"))).toBe('Text generation on the Model endpoint "openai" failed: this Environment has no binding to the agents Worker for it.');
  });

  it("keeps the Model proxy's path for its `anthropic/…` models", async () => {
    const calls = bind(() => ({ ok: true, text: "{}" }));
    const proxied: Array<string> = [];
    vi.stubGlobal("fetch", async (url: string) => {
      proxied.push(url);
      return Response.json({ content: [{ type: "text", text: '{"title":"From the proxy"}' }] });
    });
    expect(await run("anthropic/claude-haiku-5-5")).toEqual(Exit.succeed({ title: "From the proxy" }));
    expect(proxied).toEqual(["https://proxy.example/v1/messages"]);
    expect(calls).toEqual([]);
  });

  it("says what to do when no endpoint has a small model and there is no Model proxy", async () => {
    bindEnvironmentServices({ agents: {}, modelProxy: undefined, modelEndpoints: () => ({ revision: 1, endpoints: [BIG] }) } as unknown as EnvironmentServices);
    expect(detailOf(await run("default"))).toBe("No Model endpoint has a small model for text generation: pick a model for it in Settings.");
  });
});
