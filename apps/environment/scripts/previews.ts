// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off anyUnknownInErrorContext:off
// G11's stage harness (docs/steps/previews.md): Browser Run, the Container previews and the hostile cases, on the
// throwaway stage `previews`. Evidence goes to docs/steps/previews/<name>.json; no token, cookie or page URL beyond the
// harness's own is written.
//
//   node scripts/stage.ts run previews previews <part>
//   parts: spike | routes | close
import * as fs from "node:fs";
import * as path from "node:path";

import { admin, base, sleep } from "./lib/client.ts";

const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/previews");

const writeEvidence = (name: string, value: Record<string, unknown>) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, `${name}.json`), `${JSON.stringify({ at: new Date().toISOString(), host: base.host, ...value }, null, 1)}\n`);
  console.log(`${name}: ${value.ok === true ? "PASS" : "FAIL"} -> docs/steps/previews/${name}.json`);
  if (value.ok !== true) process.exitCode = 1;
};

interface Line {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: unknown;
}

const spike = async (op: string): Promise<ReadonlyArray<Line>> => {
  const { status, json } = await admin("POST", `/_t3flare/previews/spike?op=${op}`);
  if (status !== 200) throw new Error(`spike ${op}: HTTP ${status} ${JSON.stringify(json).slice(0, 300)}`);
  return (json as { lines: ReadonlyArray<Line> }).lines;
};

const print = (lines: ReadonlyArray<Line>) => {
  for (const line of lines) console.log(`${line.ok ? "ok  " : "FAIL"} ${String(line.ms).padStart(6)} ms  ${line.name}  ${line.detail === undefined ? "" : JSON.stringify(line.detail).slice(0, 400)}`);
};

const [part] = process.argv.slice(2);

switch (part) {
  case "spike": {
    // M0 questions 1, 3 (and review M2, M3, M6, H1): one browser, every call t3 makes, then the HTML page sequence.
    const calls = await spike("playwright");
    print(calls);
    const htmlPage = await spike("html-page");
    print(htmlPage);
    // Question 2: the same browser's routes from three later invocations over five minutes, each also through a fresh
    // `connect` to the stored session.
    const later: Array<{ readonly at: string; readonly lines: ReadonlyArray<Line> }> = [];
    for (const wait of [60_000, 120_000, 120_000]) {
      await sleep(wait);
      const lines = await spike("routes");
      print(lines);
      later.push({ at: new Date().toISOString(), lines });
    }
    const closed = await spike("close");
    print(closed);
    // The answer to question 2: every later invocation reached spike-a's routes through a fresh `connect`.
    const routesHeld = later.every(({ lines }) => lines.some((line) => line.ok && line.name.startsWith("connectSession") && JSON.stringify(line.detail).includes("spike-a")));
    writeEvidence("m0-spike", { ok: routesHeld, playwright: calls, htmlPage, routes: later, closed });
    break;
  }
  case "routes":
    print(await spike("routes"));
    break;
  case "close":
    print(await spike("close"));
    break;
  default:
    console.error("usage: node scripts/stage.ts run previews previews spike|routes|close");
    process.exit(2);
}
