import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { STATIC_CATALOG } from "@t3flare/models/catalog";
import { it } from "vitest";
import fixtures from "../../../packages/models/test/fixtures/proxy.json" with { type: "json" };
import { proxyModels } from "../src/session/models.ts";

it("records", async () => {
  const models = proxyModels({ url: "https://proxy.example", apiKey: "cms_key" }, () => STATIC_CATALOG);
  const model = models.getModels("anthropic")[0]!;
  const out: Record<string, unknown> = {};
  const cases: Array<[string, () => Response]> = [
    ...Object.entries(fixtures.answers).map(([name, a]) => [name, () => new Response(a.body, { status: a.status, headers: { ...a.headers, "content-type": "application/json" } })] as [string, () => Response]),
    ...Object.entries(fixtures.streamed).map(([name, frame]) => [`streamed.${name}`, () => new Response(`event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n${frame}`, { status: 200, headers: { "content-type": "text/event-stream" } })] as [string, () => Response]),
  ];
  for (const [name, make] of cases) {
    let calls = 0;
    const message = await models.complete(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { fetch: (async () => { calls++; return make(); }) as typeof fetch });
    out[name] = { stopReason: message.stopReason, errorMessage: message.errorMessage, retryable: isRetryableAssistantError(message), calls };
  }
  (await import("node:fs")).writeFileSync("/tmp/pi-ai-view.json", JSON.stringify(out, null, 2));
});
