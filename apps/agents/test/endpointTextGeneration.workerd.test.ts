// The agents Worker's `EndpointTextGeneration` entrypoint (SPI-1163), in workerd: it refuses a malformed request before
// reaching the Environment, and otherwise reads the endpoint from the Environment (`modelEndpoints`) rather than from the
// caller, so an id the Environment no longer has fails naming it.
import { describe, expect, it } from "vitest";

import { EndpointTextGeneration, type TextGenerationEnv } from "../src/endpointTextGeneration.ts";

/** An Environment namespace whose one object answers `modelEndpoints` with none, counting its calls. */
const environment = () => {
  const calls: Array<string> = [];
  const stub = {
    modelEndpoints: async () => (calls.push("modelEndpoints"), { revision: 1, endpoints: [] }),
    endpointCredential: async () => (calls.push("endpointCredential"), { apiKey: null }),
  };
  const namespace = { idFromName: (name: string) => name, get: () => stub } as unknown as DurableObjectNamespace;
  return { calls, namespace };
};

const entrypoint = (namespace: DurableObjectNamespace) =>
  // SAFETY: a WorkerEntrypoint is constructed with the execution context and its env, as workerd does.
  new (EndpointTextGeneration as unknown as new (ctx: ExecutionContext, env: TextGenerationEnv) => EndpointTextGeneration)({ waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext, { ENVIRONMENT: namespace });

describe("EndpointTextGeneration", () => {
  it("refuses a malformed request without asking the Environment anything", async () => {
    const { calls, namespace } = environment();
    for (const input of [{ endpoint: { id: "gw", api: "anthropic-messages", baseUrl: "https://evil.example", headers: {}, models: [] }, modelId: "m", prompt: "p" }, { endpointId: "gw" }, null]) {
      expect(await entrypoint(namespace).generate(input)).toEqual({ ok: false, error: "The text generation request was malformed: it names no Model endpoint, model and prompt." });
    }
    expect(calls).toEqual([]);
  });

  it("reads the endpoint from the Environment, never the caller", async () => {
    const { calls, namespace } = environment();
    expect(await entrypoint(namespace).generate({ endpointId: "gw", modelId: "m", prompt: "p" })).toEqual({ ok: false, error: 'The Model endpoint "gw" was removed: pick another model for text generation.' });
    expect(calls).toEqual(["modelEndpoints"]);
  });
});
