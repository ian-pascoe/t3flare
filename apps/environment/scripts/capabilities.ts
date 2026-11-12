// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off
// SPI-994's stage check: what a stock client is told the Cloud Environment does (and SPI-995's: analytics off; D5 lifted). Through t3's own protocol it reads the
// server config (the descriptor's capabilities and the managed policy) and tries to turn guest links on, which the
// policy refuses. Run against a stage:
//
//   node scripts/stage.ts run <stage> capabilities [--out file.json]
import * as fs from "node:fs";

import { pair, wsCall } from "./lib/client.ts";
import { CAPABILITIES } from "../src/t3/capabilities.ts";

const outIndex = process.argv.indexOf("--out");
const out = outIndex === -1 ? undefined : process.argv[outIndex + 1];
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null).slice(0, 400)}`);
};

const cookie = await pair();
const config = (await wsCall(cookie, "server.getConfig", {})) as any;
const capabilities: Record<string, unknown> = config.environment?.capabilities ?? {};
const stripped = Object.entries(CAPABILITIES).flatMap(([key, value]) => ("strip" in value ? [key] : []));
const advertisedStripped = stripped.filter((key) => key in capabilities);
check("no stripped capability is advertised", advertisedStripped.length === 0, advertisedStripped);
check("kept capabilities are advertised", capabilities.pullRequests === true && capabilities.peerLinks === true, capabilities);
check("the managed policy is t3flare's", config.managedPolicy?.organization === "t3flare", config.managedPolicy);
check("product analytics is off (SPI-995)", config.managedPolicy?.limits?.telemetry === false, config.managedPolicy);
check("guest links are locked", (config.managedPolicy?.lockedSettings ?? []).includes("guestSharingEnabled"), config.managedPolicy);
// D5 lifted (owner, 2026-11-12, back to stock): t3's typed-key settings work as stock.
check("custom text generators are unlocked", !(config.managedPolicy?.lockedSettings ?? []).includes("textGenerators"), config.managedPolicy);
check("cloud voice transcription is advertised", capabilities.cloudVoiceTranscription === true, capabilities);

const refused = await wsCall(cookie, "server.updateSettings", { patch: { guestSharingEnabled: true } }).then(
  (value) => ({ ok: true, value }),
  (error: unknown) => ({ ok: false, error: String((error as { message?: string })?.message ?? error).slice(0, 300) }),
);
const after = (await wsCall(cookie, "server.getConfig", {})) as any;
check("turning guest links on is refused", after.settings?.guestSharingEnabled === false, { refused, after: after.settings?.guestSharingEnabled });

const report = {
  at: new Date().toISOString(),
  label: config.environment?.label,
  platform: config.environment?.platform,
  advertised: Object.keys(capabilities).sort((a, b) => a.localeCompare(b)),
  stripped,
  managedPolicy: config.managedPolicy ?? null,
  guestLinksWrite: refused,
  guestSharingEnabledAfter: after.settings?.guestSharingEnabled,
  ok: failures.length === 0,
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
