// @effect-diagnostics asyncFunction:off
// The agents Worker's entrypoint for text generation on a Model endpoint's model (SPI-1163): the Environment DO's
// `TEXT_GENERATION` service binding calls `generate` with the endpoint's id, the model's and the prompt. No key and no
// endpoint cross that call: the endpoint is read from the Environment (`modelEndpoints`) and its key asked for its target
// (`endpointCredential`), as a Session does (ADR-0018). The Worker has no public URL, so only that binding reaches it.
//
// Subscription endpoints (OAuth sign-ins, SPI-1164/1165) come through the same provider code a Session uses
// (`endpointProviders` in session/models.ts). What SPI-1164 still touches for them here: `endpointProviders`' resolver and
// `ENDPOINT_STREAMS` (a sign-in's credential from the broker, and its APIs, such as Codex's backend), and the texts that
// say "API key" (`credentialProblem`, and `statusProblem` in endpointText.ts) for an endpoint whose credential is a
// sign-in.
import type { EndpointTextAnswer } from "@t3flare/models/endpoints";
import { WorkerEntrypoint } from "cloudflare:workers";

import { generateEndpointText } from "./endpointText.ts";
import { environmentStub } from "./environment.ts";

export interface TextGenerationEnv {
  readonly ENVIRONMENT: DurableObjectNamespace;
}

export class EndpointTextGeneration extends WorkerEntrypoint<TextGenerationEnv> {
  async generate(input: unknown): Promise<EndpointTextAnswer> {
    const environment = () => environmentStub(this.env.ENVIRONMENT);
    return generateEndpointText(input, {
      endpoints: () => environment().modelEndpoints(),
      credential: (endpointId, target) => environment().endpointCredential({ endpointId, target }),
    });
  }
}
