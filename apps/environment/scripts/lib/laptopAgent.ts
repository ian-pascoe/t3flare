// @effect-diagnostics nodeBuiltinImport:off
// Step 3, M0 R6: the laptop's agent is t3's own Pi provider (`pi --mode rpc`) with an isolated agent directory whose
// models.json names the stage's Model endpoint (`T3FLARE_MODEL_ENDPOINT`, with its `models`, which `stage.ts run` passes
// from ~/.config/t3flare/dev.env) as one pi provider. The key is never written: models.json names
// `$T3FLARE_LAPTOP_MODEL_KEY`, which the laptop server's environment carries.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { stageEndpointSpec } from "./modelEndpointSpec.ts";

/** The variable the laptop's pi reads its endpoint's key from (named in models.json, never written there). */
export const LAPTOP_KEY_VAR = "T3FLARE_LAPTOP_MODEL_KEY";

/** The stage's Model endpoint as pi's `models.json` names it (one provider, its listed models), its key's value, its first model's slug. */
export const laptopModels = (env: Readonly<Record<string, string | undefined>> = process.env) => {
  const endpoint = stageEndpointSpec(env);
  if (!endpoint.ok) throw new Error(`the laptop agent needs the stage's Model endpoint: ${endpoint.reason}`);
  const { spec } = endpoint;
  const models = spec.models ?? [];
  if (models.length === 0) throw new Error("the laptop agent needs T3FLARE_MODEL_ENDPOINT to list its models");
  const provider = {
    name: spec.label,
    baseUrl: spec.baseUrl,
    api: spec.api,
    apiKey: `$${LAPTOP_KEY_VAR}`,
    ...(Object.keys(spec.headers).length === 0 ? {} : { headers: spec.headers }),
    models: models.map((id) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 })),
  };
  return { modelsJson: JSON.stringify({ providers: { [spec.id]: provider } }, null, 1), key: spec.apiKey, model: `${spec.id}/${models[0]!}` };
};

/** The laptop server's extra environment for its Pi agent; writes `<dir>/pi-agent/models.json`. */
export const laptopPiEnvironment = (dir: string): Record<string, string> => {
  const laptop = laptopModels();
  const agentDir = path.join(dir, "pi-agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), laptop.modelsJson, { mode: 0o600 });
  return { PI_CODING_AGENT_DIR: agentDir, [LAPTOP_KEY_VAR]: laptop.key };
};

/** The pi binary on this machine, for the laptop's Pi provider instance. */
export const piBinary = (): string => {
  const found = spawnSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" }).stdout.trim();
  if (found === "") throw new Error("no pi binary on PATH");
  return found;
};

/** The laptop's Pi provider instance, on, with this machine's pi. */
export const piInstanceMutation = () => ({
  operation: "upsert",
  instanceId: "pi",
  instance: { driver: "pi", enabled: true, config: { binaryPath: piBinary() } },
});

/** The laptop's model: the stage's Model endpoint's first model, on t3's Pi provider. */
export const laptopModel = () => ({ instanceId: "pi", model: laptopModels().model });
