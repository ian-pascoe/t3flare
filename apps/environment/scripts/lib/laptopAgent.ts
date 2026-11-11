// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// Step 3, M0 R6: the laptop's agent is t3's own Pi provider (`pi --mode rpc`) with an isolated agent directory whose
// models.json routes Anthropic through the model proxy (ADR-0012). The key is never written: models.json names
// `$MODEL_PROXY_API_KEY`, which the laptop server's environment carries from `stage.ts run`.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** The laptop server's extra environment for its Pi agent; writes `<dir>/pi-agent/models.json`. */
export const laptopPiEnvironment = (dir: string): Record<string, string> => {
  const url = process.env.MODEL_PROXY_URL;
  if (!url || !process.env.MODEL_PROXY_API_KEY) throw new Error("the laptop agent needs MODEL_PROXY_URL and MODEL_PROXY_API_KEY (stage.ts run)");
  const agentDir = path.join(dir, "pi-agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({ providers: { anthropic: { baseUrl: url, apiKey: "$MODEL_PROXY_API_KEY" } } }, null, 1),
    { mode: 0o600 },
  );
  return { PI_CODING_AGENT_DIR: agentDir };
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

export const LAPTOP_MODEL = { instanceId: "pi", model: "anthropic/claude-haiku-5-5" };
