// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off
// Step 3, M0 R6: the laptop's agent. t3's Pi provider on the npm laptop server, on the model proxy, runs one turn that
// calls `orchestrator_capabilities` (t3's MCP tool, through t3's own Pi bridge). Writes
// docs/steps/step-3/m0-laptop-agent.json.
//
//   bun scripts/stage.ts run step3 peer-laptop-agent [--version V]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { itemsOf, runsOf, SETTLED, uuid, waitFor } from "./lib/client.ts";
import { writeEvidence } from "./lib/evidence.ts";
import { Laptop } from "./lib/laptop.ts";
import { LAPTOP_MODEL, laptopPiEnvironment, piInstanceMutation } from "./lib/laptopAgent.ts";

const at = process.argv.indexOf("--version");
const version = at < 0 ? "0.1.9-nightly.20261111.4515" : process.argv[at + 1]!;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3flare-laptop-"));
const laptop = new Laptop({ version, port: 47914, dir, env: laptopPiEnvironment(dir) });
const out: Record<string, unknown> = { version };
let ok = false;
try {
  await laptop.start();
  const cookie = await laptop.pair();
  await laptop.client.wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: piInstanceMutation() });
  const work = path.join(dir, "project");
  fs.mkdirSync(work, { recursive: true });
  const projectId = uuid();
  await laptop.client.mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId, title: "r6", workspaceRoot: work, createWorkspaceRootIfMissing: false });
  const threadId = uuid();
  await laptop.client.dispatch(cookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId,
    projectId,
    title: "r6",
    modelSelection: LAPTOP_MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  await laptop.client.sendMessage(cookie, threadId, "Call the T3 Code tool orchestrator_capabilities with no arguments, then reply with the word DONE and the number of providers it listed.", LAPTOP_MODEL as never);
  const { projection, ms } = await waitFor(cookie, threadId, (p) => runsOf(p).length > 0 && runsOf(p).every((run) => SETTLED.has(run.status)), 240_000, laptop.client);
  const items = itemsOf(projection);
  const tools = items.filter((item: any) => /tool|mcp/.test(String(item.type))).map((item: any) => ({ type: item.type, name: item.toolName ?? item.name ?? item.server ?? null, status: item.status }));
  const reply = items.filter((item: any) => item.type === "assistant_message").map((item: any) => String(item.text ?? "")).join("\n");
  out.turn = { ms, runs: runsOf(projection).map((run) => run.status), tools, reply: reply.slice(0, 400), types: [...new Set(items.map((item: any) => item.type))] };
  ok = runsOf(projection)[0]?.status === "completed" && JSON.stringify(tools).includes("orchestrator_capabilities");
} catch (error) {
  out.error = String(error).slice(0, 1000);
} finally {
  await laptop.stop();
  out.ok = ok;
  writeEvidence("m0-laptop-agent.json", out);
  console.log(JSON.stringify(out, null, 1));
  if (!ok) console.log(`log: ${laptop.logFile}`);
}
process.exit(ok ? 0 : 1);
