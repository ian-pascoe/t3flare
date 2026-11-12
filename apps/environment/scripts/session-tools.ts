// @effect-diagnostics globalConsole:off
// Step 3 (debugging): a Session's T3 tool calls and their results, as its committed entries hold them.
//
//   node scripts/stage.ts run step3 session-tools <threadId>
import { admin } from "./lib/client.ts";

const thread = process.argv[2] ?? "";
const state = (await admin("GET", `/_t3flare/agents/session?thread=${encodeURIComponent(thread)}`)).json;
for (const entry of state?.entries ?? []) {
  if (entry.role === "toolResult") console.log(JSON.stringify({ tool: entry.toolName, isError: entry.isError, content: JSON.stringify(entry.content).slice(0, 400) }));
  if (entry.role === "assistant") for (const block of entry.content ?? []) if (block.type === "toolCall") console.log(JSON.stringify({ call: block.name, args: JSON.stringify(block.arguments).slice(0, 200) }));
}
console.log(JSON.stringify({ turns: state?.turns, live: state?.live?.tools, approvals: state?.approvals }).slice(0, 1500));
console.log(JSON.stringify((await admin("GET", `/_t3flare/agents/session-tools?thread=${encodeURIComponent(thread)}`)).json).slice(0, 300));
