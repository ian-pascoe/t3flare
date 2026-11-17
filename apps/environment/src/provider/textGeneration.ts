// @effect-diagnostics globalFetch:off globalFetchInEffect:off globalJsonInEffect:off effectFnOpportunity:off
// The Durable agent provider's text generation (thread titles, commit messages, PR content; step 2a plan, section 1):
// one request from the Environment DO, with no Session and no tools.
//
// - A Model endpoint's model (`<endpointId>/<modelId>`, SPI-1163) runs on the agents Worker, through pi-ai, over the
//   `TEXT_GENERATION` service binding: the Environment's bundle never holds pi-ai. The call carries ids only; the agents
//   Worker reads the endpoint and asks for its key as a Session does.
// - `default`, and an old selection (`isRetiredSlug`: a bare id, `anthropic/<id>`), is the
//   endpoints' small model (`defaultTextModel`), else their default model (`defaultSmallModel`). With no endpoint that
//   lists a model, text generation says to set one up.
//
// Every failure says which endpoint failed, and never holds a vendor's body or a key. On an endpoint's
// model, a failure t3's own operations add after the reply (`fromRunner`: `generatedThreadTitle`'s placeholder title, and
// `withoutInvestigation`'s refusal) is named too (`namingEndpoint`).
import { type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { defaultSmallModel, EMPTY_ENDPOINTS, endpointLabel, isRetiredSlug, type ModelEndpoint, type ModelEndpoints, NO_ENDPOINT_MESSAGE, parseEndpointSlug } from "@t3flare/models/endpoints";
import * as Effect from "effect/Effect";

import { environmentServices } from "../agents/bindings.ts";

const TIMEOUT_MS = 120_000;

const fail = (operation: TextGenerationOperations.Operation, detail: string, cause?: unknown) =>
  new TextGenerationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

/** Where a selection's model runs: an endpoint's model, or nowhere (with why). */
export type TextModel = { readonly kind: "endpoint"; readonly endpoint: ModelEndpoint; readonly modelId: string } | { readonly kind: "none"; readonly detail: string };

export const textModelOf = (selected: string, endpoints: ModelEndpoints): TextModel => {
  const slug = isRetiredSlug(selected) ? defaultSmallModel(endpoints) : selected;
  const parsed = slug === undefined ? undefined : parseEndpointSlug(slug);
  if (parsed === undefined) return { kind: "none", detail: NO_ENDPOINT_MESSAGE };
  const endpoint = endpoints.endpoints.find((entry) => entry.id === parsed.endpointId);
  if (endpoint === undefined) return { kind: "none", detail: `${endpointLabel(parsed.endpointId)} was removed: pick another model for text generation.` };
  if (!endpoint.models.some((model) => model.id === parsed.modelId)) {
    return { kind: "none", detail: `${endpointLabel(endpoint.id)} no longer lists the model ${parsed.modelId}: pick another model for text generation.` };
  }
  return { kind: "endpoint", endpoint, modelId: parsed.modelId };
};

/** One request on an endpoint's model, on the agents Worker: the model's text. */
const endpointText = (operation: TextGenerationOperations.Operation, prompt: string, endpoint: ModelEndpoint, modelId: string) =>
  Effect.gen(function* () {
    const named = `${endpointLabel(endpoint.id)} could not be used for text generation`;
    const binding = environmentServices().agents.TEXT_GENERATION;
    if (binding === undefined) return yield* fail(operation, `${named}: this Environment has no binding to the agents Worker for it.`);
    const answer = yield* Effect.tryPromise({
      try: () => binding.generate({ endpointId: endpoint.id, modelId, prompt }),
      // The binding's own error text is the platform's, not the endpoint's: kept as the cause only.
      catch: (cause) => fail(operation, `${named}: the agents Worker could not be reached.`, cause),
    }).pipe(
      Effect.timeoutOrElse({ duration: TIMEOUT_MS, orElse: () => Effect.fail(fail(operation, `${endpointLabel(endpoint.id)} did not answer in time.`)) }),
    );
    if (!answer.ok) return yield* fail(operation, answer.error);
    return answer.text;
  });

export const runText: TextGenerationOperations.Runner = (request) =>
  Effect.gen(function* () {
    const services = environmentServices();
    const target = textModelOf(request.modelSelection.model, services.modelEndpoints?.() ?? EMPTY_ENDPOINTS);
    if (target.kind === "none") return yield* fail(request.operation, target.detail);
    const text = yield* endpointText(request.operation, request.prompt, target.endpoint, target.modelId);
    // Every failure names the endpoint and its model, an unusable reply's too.
    return yield* TextGenerationOperations.decodeJsonReply(request, modelLabel(target.endpoint.id, target.modelId), text);
  });

/** How a failure names an endpoint's model: `The Model endpoint "<id>" (model <modelId>)`. */
const modelLabel = (endpointId: string, modelId: string): string => `${endpointLabel(endpointId)} (model ${modelId})`;

/** The endpoint and model a selection runs on, when it is an endpoint's (`default` resolved as `runText` does). */
const endpointModelOf = (selection: ModelSelection): { readonly endpointId: string; readonly modelId: string } | undefined => {
  const services = environmentServices();
  const target = textModelOf(selection.model, services.modelEndpoints?.() ?? EMPTY_ENDPOINTS);
  if (target.kind === "endpoint") return { endpointId: target.endpoint.id, modelId: target.modelId };
  return isRetiredSlug(selection.model) ? undefined : parseEndpointSlug(selection.model);
};

/** A failure on an endpoint's model that does not name it yet, named: `The Model endpoint "e" (model m): <detail>`. */
const namedFailure = (error: TextGenerationError, selection: ModelSelection): TextGenerationError => {
  const at = endpointModelOf(selection);
  if (at === undefined || error.detail.includes('Model endpoint "')) return error;
  return new TextGenerationError({ operation: error.operation, detail: `${modelLabel(at.endpointId, at.modelId)}: ${error.detail}`, cause: error });
};

const namingEndpoint =
  <I extends { readonly modelSelection: ModelSelection }, A>(operation: (input: I) => Effect.Effect<A, TextGenerationError>) =>
  (input: I): Effect.Effect<A, TextGenerationError> =>
    operation(input).pipe(Effect.mapError((error) => namedFailure(error, input.modelSelection)));

export const makePiDurableTextGeneration = (): ProviderTextGeneration => {
  const base = TextGenerationOperations.fromRunner("PiDurableTextGeneration", TextGenerationOperations.withoutInvestigation("Pi Durable", runText));
  return {
    generateTranscriptionPostProcessing: namingEndpoint(base.generateTranscriptionPostProcessing),
    generateCommitMessage: namingEndpoint(base.generateCommitMessage),
    generatePrContent: namingEndpoint(base.generatePrContent),
    generateBranchName: namingEndpoint(base.generateBranchName),
    generateThreadTitle: namingEndpoint(base.generateThreadTitle),
    generateReviewGuide: namingEndpoint(base.generateReviewGuide),
  };
};
