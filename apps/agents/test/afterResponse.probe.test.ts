// M0 probe (scratch): does an `afterResponse` hook that rewrites a limited response's errorMessage stop pi-durable's
// retries (1 request, no backoff) and become the submission's `detail`?
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, GenerationTask, Harness, hook, MemoryStorage } from "@earendil-works/pi-durable";
import { STATIC_CATALOG } from "@t3flare/models/catalog";
import { expect, it } from "vitest";
import fixtures from "../../../packages/models/test/fixtures/proxy.json" with { type: "json" };
import { proxyModels } from "../src/session/models.ts";

const context = BACKGROUND_CONTEXT;

const run = async (rewrite: boolean) => {
  let requests = 0;
  const answer = fixtures.answers.cooldown;
  const fetch = (async () => {
    requests++;
    return new Response(answer.body, { status: answer.status, headers: { ...answer.headers, "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  const models = proxyModels({ url: "https://proxy.example", apiKey: "k" }, () => STATIC_CATALOG, fetch);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "probe",
      hooks: rewrite
        ? [hook(GenerationTask, { afterResponse: (message) => void (message.stopReason === "error" && (message.errorMessage = "t3flare: proxy failure proxy_cooldown")) })]
        : [],
    }),
  );
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 10 } } }, context);
  const root = await harness.root(context, { agent: { model: { provider: "anthropic", modelId: "claude-haiku-5-5" } } });
  const submission = await root.submit({ type: "input", content: "hi" }, context);
  harness.resume();
  const started = Date.now();
  for (;;) {
    const status = await submission.status(context);
    if (status.status === "done" || status.status === "unanswered") return { requests, status, ms: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

it("probe", async () => {
  const plain = await run(false);
  const rewritten = await run(true);
  const out = { plain: { requests: plain.requests, status: plain.status }, rewritten: { requests: rewritten.requests, status: rewritten.status } };
  (await import("node:fs")).writeFileSync("/tmp/after-response-probe.json", JSON.stringify(out, null, 2));
  expect(rewritten.requests).toBe(1);
});
