// @effect-diagnostics asyncFunction:off
// The agents Worker's entrypoint for text generation on a Model endpoint's model (SPI-1163): the Environment DO's
// `TEXT_GENERATION` service binding calls `generate` with the endpoint as the Environment holds it now (secret-free), the
// model and the prompt. No key crosses that call: the key is asked of the Environment (`endpointCredential`) for the
// endpoint's target, as a Session asks for it (ADR-0018), so the Environment gives it only where the endpoint points now.
// The Worker has no public URL, so only that binding reaches it.
//
// A subscription endpoint (an OAuth sign-in, SPI-1164/1165) needs nothing here: the credential comes through the same
// resolver as a Session's (`endpointProviders` in session/models.ts), which takes its token from the broker once sign-ins
// exist.
import { ENDPOINT_APIS, type EndpointTextAnswer, type EndpointTextRequest, isRecord } from "@t3flare/models/endpoints";
import { WorkerEntrypoint } from "cloudflare:workers";

import { generateEndpointText } from "./endpointText.ts";
import { environmentStub } from "./environment.ts";

interface TextGenerationEnv {
  readonly ENVIRONMENT: DurableObjectNamespace;
}

/** The request as the binding hands it: refused unless it has the shape the Environment sends. */
const requestOf = (value: unknown): EndpointTextRequest | undefined => {
  if (!isRecord(value) || typeof value.modelId !== "string" || typeof value.prompt !== "string" || !isRecord(value.endpoint)) return undefined;
  const endpoint = value.endpoint;
  if (typeof endpoint.id !== "string" || typeof endpoint.api !== "string" || !(ENDPOINT_APIS as ReadonlyArray<string>).includes(endpoint.api)) return undefined;
  if (typeof endpoint.baseUrl !== "string" || !isRecord(endpoint.headers) || !Array.isArray(endpoint.models)) return undefined;
  // SAFETY: the fields the request is used by were checked above; the rest is the Environment's stored endpoint as is.
  return value as unknown as EndpointTextRequest;
};

export class EndpointTextGeneration extends WorkerEntrypoint<TextGenerationEnv> {
  async generate(input: EndpointTextRequest): Promise<EndpointTextAnswer> {
    const request = requestOf(input);
    if (request === undefined) return { ok: false, error: "The text generation request was malformed." };
    const environment = environmentStub(this.env.ENVIRONMENT);
    return generateEndpointText(request, { credential: (endpointId, target) => environment.endpointCredential({ endpointId, target }) });
  }
}
