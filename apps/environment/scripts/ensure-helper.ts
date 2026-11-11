// @effect-diagnostics globalConsole:off
// Step 3: points a Workspace's repo at the current git credential helper (repos cloned before it changed).
//
//   bun scripts/stage.ts run step3 ensure-helper <workspaceId>
import { admin } from "./lib/client.ts";

const id = process.argv[2] ?? "";
const answer = await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(id)}`, { credentialHelper: true });
console.log(JSON.stringify({ exitCode: answer.json?.result?.exitCode, helperSet: String(answer.json?.result?.stdout ?? "").includes("op=") }));
