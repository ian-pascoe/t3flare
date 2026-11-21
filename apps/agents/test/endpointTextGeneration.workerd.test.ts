// The agents Worker's `EndpointTextGeneration` entrypoint (SPI-1163), in workerd: it reads the endpoint from the
// Environment (`modelEndpoints`) rather than from the caller, so an id the Environment no longer has fails naming it.
// Malformed requests are `generateEndpointText`'s, tested in endpointText.test.ts.
import { describe, expect, it } from "vitest";

import { EndpointTextGeneration, type TextGenerationEnv } from "../src/endpointTextGeneration.ts";

/** An Environment namespace whose one object answers `modelEndpoints` with none, counting its calls. */
const environment = () => {
  const calls: Array<string> = [];
  const stub = {
    modelEndpoints: async () => (calls.push("modelEndpoints"), { revision: 1, endpoints: [] }),
    endpointCredential: async () => (calls.push("endpointCredential"), { apiKey: null }),
  };
  // SAFETY: `EndpointTextGeneration` calls only `idFromName` and `get`, and on the stub only the two methods it answers (`modelEndpoints`, `endpointCredential`).
  const namespace = { idFromName: (name: string) => name, get: () => stub } as unknown as TextGenerationEnv["ENVIRONMENT"];
  return { calls, namespace };
};

const entrypoint = (namespace: TextGenerationEnv["ENVIRONMENT"]) =>
  // SAFETY: a WorkerEntrypoint is constructed with the execution context and its env, as workerd does.
  new (EndpointTextGeneration as unknown as new (ctx: ExecutionContext, env: TextGenerationEnv) => EndpointTextGeneration)({ waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext, { ENVIRONMENT: namespace });

describe("EndpointTextGeneration", () => {
  it("reads the endpoint from the Environment, never the caller", async () => {
    const { calls, namespace } = environment();
    expect(await entrypoint(namespace).generate({ endpointId: "gw", modelId: "m", prompt: "p" })).toEqual({ ok: false, error: 'The Model endpoint "gw" was removed: pick another model for text generation.' });
    expect(calls).toEqual(["modelEndpoints"]);
  });
});
