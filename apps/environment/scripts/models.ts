// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off globalFetch:off
// The deployed check of the model catalog (ADR-0012, docs/model-proxy.md): the Durable agent provider's snapshot lists
// the models the proxy serves under their real ids, and a turn runs on a model that is not Claude (the proxy translates)
// as well as on one that is. Run against a stage:
//
//   bun scripts/stage.ts run <stage> models [--no-turns] [--out file.json]
//
// `--no-turns` only reads the snapshot: it creates no project or thread, so it is the check to run against `prod`.
import * as fs from "node:fs";

import { createProjectAndThread, itemsOf, pair, runsOf, sendMessage, SETTLED, sleep, waitFor, wsCall } from "./lib/client.ts";

const noTurns = process.argv.includes("--no-turns");
const outIndex = process.argv.indexOf("--out");
const out = outIndex === -1 ? undefined : process.argv[outIndex + 1];
const report: Record<string, unknown> = { at: new Date().toISOString() };
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null).slice(0, 400)}`);
};

const proxyUrl = (process.env.MODEL_PROXY_URL ?? "").replace(/\/+$/, "");
const proxyKey = process.env.MODEL_PROXY_API_KEY ?? "";
const listed = (await (await fetch(`${proxyUrl}/v1/models`, { headers: { "x-api-key": proxyKey } })).json()) as { data: Array<{ id: string }> };
const proxyIds = listed.data.map((model) => model.id);

const cookie = await pair();
type Provider = { instanceId?: string; enabled?: boolean; models?: Array<Model> };
const providers = async () => ((await wsCall(cookie, "server.getConfig", {})) as { providers: Array<Provider> }).providers;
// A new Environment has the provider off (onboarding turns it on); one that has it on is left as it is.
if (!(await providers()).some((provider) => provider.instanceId === "piDurable" && provider.enabled === true)) {
  await wsCall(cookie, "server.updateSettings", {
    patch: {},
    providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } },
  });
}

// 1. The snapshot lists the proxy's models. The Environment reads the proxy's list in the background once it boots, so
//    wait for the snapshot to stop being the static list.
type Model = { slug: string; name: string; subProvider?: string; isDefault?: boolean; capabilities?: { optionDescriptors?: Array<{ id: string }> } };
let models: Array<Model> = [];
const started = Date.now();
while (Date.now() - started < 90_000) {
  models = (await providers()).find((provider) => provider.instanceId === "piDurable")?.models ?? [];
  if (models.length > 4) break;
  await sleep(3000);
}
const slugs = models.map((model) => model.slug);
report.snapshot = {
  ms: Date.now() - started,
  models: models.length,
  proxyModels: proxyIds.length,
  sample: models.slice(0, 6).map((model) => `${model.slug} | ${model.name} | ${model.subProvider ?? ""}`),
  default: models.find((model) => model.isDefault)?.slug,
};
check("the snapshot lists the proxy's models", proxyIds.every((id) => slugs.includes(`anthropic/${id}`)), { missing: proxyIds.filter((id) => !slugs.includes(`anthropic/${id}`)).slice(0, 10) });
check("no alias id reaches the picker", !slugs.some((slug) => slug.includes("claude-fable-5-dd-")), slugs.filter((slug) => slug.includes("claude-fable-5-dd-")).slice(0, 5));
check("models are named, not only identified", models.filter((model) => model.name === model.slug.slice("anthropic/".length)).length < models.length / 2, report.snapshot);
check("a default model", models.filter((model) => model.isDefault).length === 1, report.snapshot);
check("a Claude model has a thinking picker, another does not", (() => {
  const claude = models.find((model) => model.slug === "anthropic/claude-haiku-5-5");
  const other = models.find((model) => model.slug === "anthropic/gemini-3-flash");
  return (claude?.capabilities?.optionDescriptors ?? []).some((option) => option.id === "thinking") && (other?.capabilities?.optionDescriptors ?? []).length === 0;
})());

// 2. A turn on each: a Claude model with thinking, and two models that are not Claude.
const turn = async (slug: string, options: Array<{ id: string; value: string }>) => {
  const stamp = Date.now().toString(36);
  const { threadId } = await createProjectAndThread(cookie, { title: `models ${stamp}`, workspaceRoot: `/t3/home/models-${stamp}` });
  const model = { instanceId: "piDurable", model: slug, options };
  await sendMessage(cookie, threadId, "Reply with exactly one short sentence saying which fruit is yellow and curved.", model);
  const settled = await waitFor(cookie, threadId, (p) => runsOf(p).some((run) => SETTLED.has(run.status)), 120_000).catch((error: unknown) => ({ projection: undefined, ms: -1, error: String(error) }));
  const items = itemsOf(settled.projection);
  const message = items.find((item: any) => item.type === "assistant_message" && item.status === "completed");
  return { slug, ms: settled.ms, runs: runsOf(settled.projection).map((run) => run.status), answer: String(message?.text ?? "").slice(0, 160), error: (settled as any).error };
};
const turns = [];
if (!noTurns) for (const [slug, options] of [
  ["anthropic/claude-haiku-5-5", [{ id: "thinking", value: "low" }]],
  ["anthropic/gemini-3-flash", []],
  ["anthropic/deepseek-v4-pro", []],
] as const) {
  const result = await turn(slug, [...options]);
  turns.push(result);
  check(`a turn on ${slug}`, result.runs[0] === "completed" && result.answer.length > 0, result);
}
report.turns = turns;

report.failures = failures;
report.ok = failures.length === 0;
if (out !== undefined) fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
