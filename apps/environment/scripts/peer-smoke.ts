// @effect-diagnostics globalConsole:off
// Step 3: one owner's turn on the Durable agent with `prompt` (default: call T3's orchestrator_capabilities and
// t3_thread_list), approvals accepted; prints the T3 tool calls and the reply.
//
//   bun scripts/stage.ts run step3 peer-smoke [--mode full-access] [prompt…]
import { pair } from "./lib/client.ts";
import { approveAll, createThread, replyOf, say, t3Calls } from "./lib/cloudThread.ts";
import { ensureCloudFixtureProject } from "./lib/fixtureProject.ts";

const at = process.argv.indexOf("--mode");
const mode = at < 0 ? "full-access" : process.argv[at + 1]!;
const words = process.argv.slice(2).filter((word, index, all) => word !== "--mode" && all[index - 1] !== "--mode");
const prompt = words.length > 0 ? words.join(" ") : "Call the T3 tool orchestrator_capabilities, then t3_thread_list, then reply with how many threads it listed.";
const cookie = await pair();
const fixture = await ensureCloudFixtureProject(cookie);
const threadId = await createThread(cookie, fixture.projectId, { title: "step3 smoke", runtimeMode: mode });
await say(cookie, threadId, prompt);
const { projection, answered } = await approveAll(cookie, threadId);
console.log(JSON.stringify({ threadId, runs: projection?.runs?.map((r: any) => r.status), answered: answered.map((r) => ({ kind: r.kind })), calls: t3Calls(projection), reply: replyOf(projection).slice(0, 600) }, null, 1));
