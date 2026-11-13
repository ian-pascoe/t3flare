// @effect-diagnostics globalConsole:off nodeBuiltinImport:off globalTimers:off
// Workers Logs of a stage, tailed with `wrangler tail` while some work runs, kept in memory and never printed (the leak
// scans compare them by name). From the tools step's `tools.ts`. wrangler authenticates with $CLOUDFLARE_API_TOKEN, or
// the alchemy profile's token, read by this script and passed in wrangler's environment only.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { sleep } from "./client.ts";

export const tailing = async <T>(workers: ReadonlyArray<string>, work: () => Promise<T>): Promise<{ result: T; text: string; workers: Array<{ name: string; bytes: number }> }> => {
  const here = path.resolve(import.meta.dirname, "../..");
  const profile = process.env.ALCHEMY_PROFILE ?? "default";
  const credentials = process.env.CLOUDFLARE_API_TOKEN
    ? { token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "" }
    : (() => {
        const stored = JSON.parse(fs.readFileSync(path.join(process.env.HOME ?? "", ".alchemy/profiles", profile, "cloudflare.json"), "utf8")).values;
        return { token: stored.access as string, accountId: (stored.accountId as string) ?? "" };
      })();
  const chunks = new Map<string, Array<Buffer>>();
  const tails = workers.map((name) => {
    chunks.set(name, []);
    const tail = spawn(path.join(here, "node_modules/.bin/wrangler"), ["tail", name, "--format", "json"], {
      cwd: here,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: credentials.token, CLOUDFLARE_ACCOUNT_ID: credentials.accountId },
      stdio: ["ignore", "pipe", "ignore"],
    });
    tail.stdout.on("data", (chunk: Buffer) => chunks.get(name)!.push(chunk));
    return tail;
  });
  await sleep(8000);
  try {
    const result = await work();
    await sleep(10_000);
    return { result, text: [...chunks.values()].map((parts) => Buffer.concat(parts).toString("utf8")).join("\n"), workers: [...chunks].map(([name, parts]) => ({ name, bytes: Buffer.concat(parts).length })) };
  } finally {
    for (const tail of tails) tail.kill("SIGINT");
  }
};
