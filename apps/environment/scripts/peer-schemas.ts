// @effect-diagnostics globalConsole:off
// Step 3: prints the input schemas of t3's MCP tools on the stage (a link's view), for the acceptance test's calls.
//
//   bun scripts/stage.ts run step3 peer-schemas t3_thread_launch t3_thread_update …
import { pair } from "./lib/client.ts";
import { McpClient, mintPairingCode, signIn } from "./lib/peer.ts";

const cookie = await pair();
const link = await signIn((await mintPairingCode(cookie)).code, "full-access");
const tools = (await new McpClient(link.token).listTools()) as ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown; annotations?: unknown }>;
const wanted = new Set(process.argv.slice(2));
for (const tool of tools.filter((t) => wanted.size === 0 || wanted.has(t.name))) {
  console.log(JSON.stringify({ name: tool.name, annotations: tool.annotations, inputSchema: wanted.size === 0 ? undefined : tool.inputSchema }));
}
