// @effect-diagnostics anyUnknownInErrorContext:off globalConsole:off
// Reads the deployed environment Worker's versions and their `startup_time_ms` (the 1 s
// startup limit), with alchemy's Cloudflare credentials. Creates nothing:
//
//   bun alchemy plan -c probe.run.ts --stage spike
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";

const SCRIPT = process.env.T3FLARE_SCRIPT ?? "";

export default Alchemy.Stack(
  "t3flare-probe",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const env = yield* CloudflareEnvironment.current;
    const accountId = (env as unknown as { accountId: string }).accountId;
    const list = yield* workers.listScriptVersions({ accountId, scriptName: SCRIPT });
    const items = ((list as unknown as { items?: Array<{ id: string; number?: number }> }).items ?? []).slice(0, 10);
    for (const item of items) {
      const version = yield* workers.getBetaWorkerVersion({ accountId, workerId: SCRIPT, versionId: item.id });
      const v = version as unknown as { number?: number; metadata?: { createdOn?: string }; resources?: { script?: { startupTimeMs?: number } }; startupTimeMs?: number };
      const found: Array<string> = [];
      const walk = (value: unknown, at: string) => {
        if (value === null || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          if (/startup/i.test(key)) found.push(`${at}.${key}=${String(child)}`);
          walk(child, `${at}.${key}`);
        }
      };
      walk(version, "version");
      console.log(JSON.stringify({ number: v.number ?? item.number, createdOn: v.metadata?.createdOn, found, keys: Object.keys(version as object) }));
    }
    return {};
  }).pipe(Effect.orDie),
);
