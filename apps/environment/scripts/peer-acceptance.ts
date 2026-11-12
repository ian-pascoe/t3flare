// @effect-diagnostics globalConsole:off
// Step 3: the Peer link acceptance rows alone (`lib/peerAcceptance.ts`), with F11, against a stage. `--only F1,F2` runs
// those rows; `--out <file>` names the evidence file in docs/steps/step-3/.
//
//   node scripts/stage.ts run step3 peer-acceptance [--only launch,F5] [--out m1-acceptance-peer.json]
import { admin, pair } from "./lib/client.ts";
import { writeEvidence } from "./lib/evidence.ts";
import { bootstrapAtDecision, peerAcceptance } from "./lib/peerAcceptance.ts";

const arg = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
};
const only = arg("only");
const cookie = await pair();
const result = await peerAcceptance(cookie, only === undefined ? {} : { only: new Set(only.split(",")) });
const failures = [...result.failures];
let f11: unknown;
if (only === undefined || only.split(",").includes("F11")) {
  const token = process.env.T3_BOOTSTRAP_TOKEN ?? "";
  const armed = await bootstrapAtDecision(token, true);
  await admin("POST", "/_t3flare/disarm-bootstrap");
  const disarmed = await bootstrapAtDecision(token, false);
  f11 = { armed, disarmed };
  if (!armed.ok) failures.push(`F11: t3 alone refuses the bootstrap grant as not a pairing code: ${JSON.stringify(armed)}`);
  if (!disarmed.ok) failures.push(`F11: disarmed, the Environment DO refuses it: ${JSON.stringify(disarmed)}`);
}
const report = { ...result, F11: f11, failures, ok: failures.length === 0 };
writeEvidence(arg("out") ?? "peer-acceptance.json", report);
console.log(JSON.stringify(report, null, 1).slice(0, 8000));
process.exit(report.ok ? 0 : 1);
