// @effect-diagnostics globalFetch:off globalFetchInEffect:off globalJsonInEffect:off effectFnOpportunity:off
// The Durable agent provider's text generation (thread titles, commit messages, PR content; step 2a plan, section 1):
// one Anthropic Messages request through the deployment's model proxy, from the Environment DO, with no Session and no
// tools. Plain `fetch` rather than pi-ai, so the environment bundle stays as it was (risk R8's fallback, taken up front).
import { TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { SMALL_MODEL_SLUG } from "@t3flare/models";
import * as Effect from "effect/Effect";

import { environmentServices } from "../agents/bindings.ts";
import { modelOf } from "./adapter.ts";

const TIMEOUT_MS = 120_000;

const fail = (operation: TextGenerationOperations.Operation, detail: string, cause?: unknown) =>
  new TextGenerationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

export const runText: TextGenerationOperations.Runner = (request) =>
  Effect.gen(function* () {
    const proxy = environmentServices().modelProxy;
    if (proxy === undefined) return yield* fail(request.operation, "The model proxy is not configured.");
    const { model } = modelOf(request.modelSelection.model === "default" ? { ...request.modelSelection, model: SMALL_MODEL_SLUG } : request.modelSelection);
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
            model: model.modelId,
            max_tokens: 2048,
            messages: [{ role: "user", content: `${request.prompt}\n\nAnswer with the JSON object only.` }],
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        }),
      catch: (cause) => fail(request.operation, "The model proxy could not be reached.", cause),
    });
    if (!response.ok) {
      // Only the status reaches the message: a provider's error body can echo request details.
      return yield* fail(request.operation, `The model proxy returned HTTP ${response.status}.`);
    }
    const body = (yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => fail(request.operation, "The model proxy's answer was not JSON.", cause),
    })) as { readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }> };
    const text = (body.content ?? [])
      .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
      .join("")
      .trim();
    if (text.length === 0) return yield* fail(request.operation, "The model returned no text.");
    return yield* TextGenerationOperations.decodeJsonReply(request, "Pi (cloud)", text);
  });

export const makePiDurableTextGeneration = () =>
  TextGenerationOperations.fromRunner("PiDurableTextGeneration", TextGenerationOperations.withoutInvestigation("Pi (cloud)", runText));
