// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off
// SPI-1175's evidence on its stage, deployed with `stage.ts deploy p1175 --no-model-proxy` and passed by `acceptance`:
// what stage.ts set up through the panel's API, and that the stage has no Model proxy.
//
//   node scripts/stage.ts run p1175 p1175 [--out ../../docs/steps/spi-1175/p1175.json]
//
// 1. The endpoint stage.ts saved is in the panel, its key set and readable, and the audit log has it under `endpoints`,
//    by the service token, with no key.
// 2. The text-generation setting names the endpoint's small model with no pick by anyone, and a thread's title is
//    generated on it.
// 3. The stage has no Model proxy: text generation on the proxy's model (`anthropic/…`) answers that the Model proxy is not
//    configured. (Picking it is the owner's pick: run this last; the stage is destroyed after.)
// No key is printed: every answer kept is scanned for the keys first.
import * as fs from "node:fs";

import { defaultTextModel } from "@t3flare/models/endpoints";

import { MIN_SECRET_LENGTH, modelEndpointSpec, scrubValue, secretsOf } from "./lib/modelEndpointSpec.ts";
import { admin, createProjectAndThread, enablePiDurable, pair, regenerateTitle, sendMessage, textGenerationSetting, updateSettings } from "./lib/client.ts";

const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const out = option("out");
const spec = modelEndpointSpec(process.env, { derive: true });
if (!spec.ok) throw new Error(spec.reason);
const secrets = [...secretsOf(spec.spec), process.env.MODEL_PROXY_API_KEY].filter((value): value is string => value !== undefined && value.length >= MIN_SECRET_LENGTH);
const failures: Array<string> = [];
const report: Record<string, unknown> = { at: new Date().toISOString(), endpointFrom: spec.source };
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null).slice(0, 600)}`);
  return ok;
};
// A secret in any string of an answer kept (compared value by value, not in the JSON text: a short header value would
// match its tokens).
const clean = <T>(value: T): T => {
  if (JSON.stringify(scrubValue(value, secrets)) !== JSON.stringify(value)) throw new Error("a key reached an answer kept as evidence");
  return value;
};

// 1. The endpoint, as the panel lists it, and its audit.
const listed = await admin("GET", "/_t3flare/harness/api/endpoints");
const endpoint = listed.json?.endpoints?.find((entry: any) => entry.id === spec.spec.id);
report.endpoint = clean(
  endpoint === undefined
    ? null
    : { id: endpoint.id, label: endpoint.label, api: endpoint.api, auth: endpoint.auth, models: endpoint.models.map((model: any) => model.id), key: { set: endpoint.key?.set, readable: endpoint.key?.readable } },
);
check("the endpoint stage.ts saved is listed with a readable key", endpoint !== undefined && endpoint.key?.set === true && endpoint.key?.readable === true, report.endpoint);
const audit = await admin("GET", "/_t3flare/harness/api/audit");
const saves = (audit.json?.entries ?? []).filter((entry: any) => entry.entity === "endpoints" && entry.target === spec.spec.id);
report.audit = clean(saves.map((entry: any) => ({ action: entry.action, caller: entry.caller, key: entry.after?.key === undefined ? null : { set: entry.after.key.set } })));
check("its saves are audited, by the service token", saves.length > 0 && saves.every((entry: any) => entry.caller === "service-token"), report.audit);

// 2. The text-generation setting, picked by no one, and a title generated on it.
const cookie = await pair();
await admin("POST", "/_t3flare/disarm-bootstrap");
await enablePiDurable(cookie);
report.setting = await textGenerationSetting(cookie);
const expected = defaultTextModel({ revision: listed.json?.revision ?? 0, endpoints: listed.json?.endpoints ?? [] });
report.expectedSetting = expected ?? null;
check("text generation names the endpoint's small model", expected?.startsWith(`${spec.spec.id}/`) === true && (report.setting as any)?.model === expected, report.setting);

const { threadId } = await createProjectAndThread(cookie, { title: "New thread", workspaceRoot: `/w/p1175-${Date.now().toString(36)}` });
await sendMessage(cookie, threadId, "Please fix the failing date parser test in src/dates.ts: it treats 2024-02-29 as invalid.");
const title = await regenerateTitle(cookie, threadId);
report.title = clean(title);
check("a thread's title is generated on the endpoint's model", title.outcome === "renamed" && typeof title.title === "string" && title.title !== "New thread", title);

// 3. No Model proxy: its model's text generation says so.
await updateSettings(cookie, { textGenerationModelSelection: { instanceId: "piDurable", model: "anthropic/claude-haiku-5-5" } });
const proxyTitle = await regenerateTitle(cookie, threadId);
report.proxyModel = clean(proxyTitle);
check("the stage has no Model proxy", proxyTitle.outcome === "failed" && /model proxy is not configured/i.test(proxyTitle.message ?? ""), proxyTitle);

report.failures = failures;
report.ok = failures.length === 0;
const text = JSON.stringify(clean(report), null, 2);
console.log(text);
if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
process.exit(report.ok ? 0 : 1);
