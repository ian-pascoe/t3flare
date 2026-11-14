// @effect-diagnostics globalFetch:off globalFetchInEffect:off globalJsonInEffect:off effectFnOpportunity:off
// The Durable agent provider's text generation (thread titles, commit messages, PR content; step 2a plan, section 1):
// one request from the Environment DO, with no Session and no tools.
//
// - A Model endpoint's model (`<endpointId>/<modelId>`, SPI-1163) runs on the agents Worker, through pi-ai, over the
//   `TEXT_GENERATION` service binding: the Environment's bundle never holds pi-ai. The call carries ids only; the agents
//   Worker reads the endpoint and asks for its key as a Session does.
// - `default` is a small model of the first endpoint that has one (`defaultTextModel`), else the Model proxy's.
// - The Model proxy's `anthropic/<id>` models keep their plain Anthropic Messages request until the hard cut (SPI-1176).
//
// Every failure says which endpoint (or the proxy) failed, and never holds a vendor's body or a key. On an endpoint's
// model, a failure t3's own operations add after the reply (`fromRunner`: `generatedThreadTitle`'s placeholder title, and
// `withoutInvestigation`'s refusal) is named too (`namingEndpoint`).
import { type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { SMALL_MODEL_SLUG } from "@t3flare/models";
import { defaultTextModel, EMPTY_ENDPOINTS, endpointLabel, jsonOnlyPrompt, type ModelEndpoint, type ModelEndpoints, parseEndpointSlug } from "@t3flare/models/endpoints";
import { classifyProxyFailure, proxyFailureMessage } from "@t3flare/models/proxyFailure";
import * as Effect from "effect/Effect";

import { environmentServices } from "../agents/bindings.ts";

const TIMEOUT_MS = 120_000;
/** The Model proxy's models' provider in a slug, until the hard cut. */
const PROXY_PROVIDER = "anthropic";

const fail = (operation: TextGenerationOperations.Operation, detail: string, cause?: unknown) =>
  new TextGenerationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

/** Where a selection's model runs: an endpoint's model, the Model proxy's, or nowhere (with why). */
export type TextModel =
  | { readonly kind: "endpoint"; readonly endpoint: ModelEndpoint; readonly modelId: string }
  | { readonly kind: "proxy"; readonly modelId: string }
  | { readonly kind: "none"; readonly detail: string };

export const textModelOf = (selected: string, endpoints: ModelEndpoints, proxy: boolean): TextModel => {
  const slug = selected === "default" ? (defaultTextModel(endpoints) ?? (proxy ? SMALL_MODEL_SLUG : undefined)) : selected;
  if (slug === undefined) return { kind: "none", detail: "No Model endpoint has a small model for text generation: pick a model for it in Settings." };
  const parsed = parseEndpointSlug(slug);
  if (parsed === undefined || parsed.endpointId === PROXY_PROVIDER) return { kind: "proxy", modelId: parsed?.modelId ?? slug };
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

/** One Anthropic Messages request through the Model proxy (until the hard cut): the model's text. */
const proxyText = (operation: TextGenerationOperations.Operation, prompt: string, modelId: string) =>
  Effect.gen(function* () {
    const proxy = environmentServices().modelProxy;
    if (proxy === undefined) return yield* fail(operation, "The model proxy is not configured.");
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${proxy.url.replace(/\/$/, "")}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": proxy.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: modelId,
            max_tokens: 2048,
            messages: [{ role: "user", content: jsonOnlyPrompt(prompt) }],
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        }),
      catch: (cause) => fail(operation, "The model proxy could not be reached.", cause),
    });
    if (!response.ok) {
      // Only the classified failure's fixed text or the status reaches the message: an error body can echo request details.
      const text = yield* Effect.promise(() => response.text().catch(() => ""));
      const failure = classifyProxyFailure({ status: response.status, retryAfter: response.headers.get("retry-after"), text, at: 0 });
      return yield* fail(
        operation,
        failure === undefined ? `The model proxy returned HTTP ${response.status}.` : `${proxyFailureMessage(failure)} (HTTP ${response.status})`,
      );
    }
    const body = (yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => fail(operation, "The model proxy's answer was not JSON.", cause),
    })) as { readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }> };
    const text = (body.content ?? [])
      .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
      .join("")
      .trim();
    if (text.length === 0) return yield* fail(operation, "The model returned no text.");
    return text;
  });

export const runText: TextGenerationOperations.Runner = (request) =>
  Effect.gen(function* () {
    const services = environmentServices();
    const target = textModelOf(request.modelSelection.model, services.modelEndpoints?.() ?? EMPTY_ENDPOINTS, services.modelProxy !== undefined);
    if (target.kind === "none") return yield* fail(request.operation, target.detail);
    if (target.kind === "endpoint") {
      const text = yield* endpointText(request.operation, request.prompt, target.endpoint, target.modelId);
      // Every failure names the endpoint and its model, an unusable reply's too.
      return yield* TextGenerationOperations.decodeJsonReply(request, modelLabel(target.endpoint.id, target.modelId), text);
    }
    const text = yield* proxyText(request.operation, request.prompt, target.modelId);
    return yield* TextGenerationOperations.decodeJsonReply(request, "Pi Durable", text);
  });

/** How a failure names an endpoint's model: `The Model endpoint "<id>" (model <modelId>)`. */
const modelLabel = (endpointId: string, modelId: string): string => `${endpointLabel(endpointId)} (model ${modelId})`;

/** The endpoint and model a selection runs on, when it is an endpoint's (`default` resolved as `runText` does). */
const endpointModelOf = (selection: ModelSelection): { readonly endpointId: string; readonly modelId: string } | undefined => {
  const services = environmentServices();
  const target = textModelOf(selection.model, services.modelEndpoints?.() ?? EMPTY_ENDPOINTS, services.modelProxy !== undefined);
  if (target.kind === "endpoint") return { endpointId: target.endpoint.id, modelId: target.modelId };
  const parsed = target.kind === "none" ? parseEndpointSlug(selection.model) : undefined;
  return parsed === undefined || parsed.endpointId === PROXY_PROVIDER ? undefined : parsed;
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
