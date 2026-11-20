// @effect-diagnostics globalConsole:off nodeBuiltinImport:off processEnv:off
// The launch video's beat 6 (tools/demo-video): relaunches its isolated T3 Code, "MacBook Pro", with a laptop agent,
// t3's Pi provider on the Stage's Model endpoint (lib/laptopAgent.ts). models.json goes into the capture directory and
// names the key's variable; the key itself only reaches the instance's environment. pi is linked into the instance's
// bin, which leads its PATH.
//
//   node scripts/stage.ts run demo demo-laptop
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { laptopPiEnvironment, piBinary } from "./lib/laptopAgent.ts";

const cap = process.env.T3FLARE_DEMO_DIR ?? path.join(os.homedir(), ".cache", "t3flare-demo");
const capture = path.resolve(import.meta.dirname, "../../../tools/demo-video/capture/capture.ts");

const env = laptopPiEnvironment(cap);
// The instance's checkout sits under the real home, whose ~/.agents/skills Pi counts as the project's; untrusted, t3
// shows a notice on every turn. Pi's RPC mode cannot ask, so trust by default in this agent directory only.
fs.writeFileSync(path.join(env.PI_CODING_AGENT_DIR!, "settings.json"), `${JSON.stringify({ defaultProjectTrust: "always" }, null, 2)}\n`);
const pi = path.join(cap, "bin", "pi");
fs.mkdirSync(path.dirname(pi), { recursive: true });
fs.rmSync(pi, { force: true });
// A mise shim is mise itself, which the instance's HOME has no config for: link the binary mise resolves to.
const shim = fs.realpathSync(piBinary());
const resolved = path.basename(shim) === "mise" ? spawnSync(shim, ["which", "pi"], { encoding: "utf8" }).stdout.trim() : shim;
fs.symlinkSync(fs.realpathSync(resolved), pi);

const run = (command: string) => {
  const result = spawnSync(process.execPath, [capture, command], { stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run("stop");
run("launch");
console.log("The isolated instance has its laptop agent (tools/demo-video/README.md, Beat 6, for the one-time setup).");
