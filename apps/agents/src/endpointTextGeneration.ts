// @effect-diagnostics asyncFunction:off
// The agents Worker's entrypoint for text generation on a Model endpoint's model (SPI-1163): the Environment DO's
// `TEXT_GENERATION` service binding calls `generate` with the endpoint's id, the model's and the prompt. No key and no
// endpoint cross that call: the endpoint is read from the Environment (`modelEndpoints`) and its key asked for its target
// (`endpointCredential`), as a Session does (ADR-0018). The Worker has no public URL, so only that binding reaches it.
//
// Sign-in endpoints (SPI-1164) come through the same provider code a Session uses (`endpointProviders` in
// session/models.ts): the access token is the Credential broker's, asked for the same way, and their failures name the
// sign-in (`credentialProblem`, `statusProblem` in endpointText.ts).
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
