// @effect-diagnostics globalConsole:off globalDate:off
// Step 3, M0 R1: t3's MCP over HTTP in workerd. Signs in to the stage as a Peer link (`t3code-peer-link`) with a
// pairing code bound to auto-accept-edits, then initialize, tools/list, t3_project_list, t3_thread_read, a 50 s
// t3_thread_wait; the answers' shapes; a 404 and re-initialisation after an admin restart; a 403 with Linked
// environments off. Writes docs/steps/step-3/m0-mcp.json.
//
//   node scripts/stage.ts run step3 peer-m0
import { admin, createProjectAndThread, pair, sleep, updateSettings } from "./lib/client.ts";
import { writeEvidence } from "./lib/evidence.ts";
import { McpClient, mintPairingCode, registerPeerClient, signIn } from "./lib/peer.ts";

const out: Record<string, unknown> = {};
const cookie = await pair();
const settings = (await updateSettings(cookie, {}).catch(() => undefined)) as { linkedEnvironmentsEnabled?: boolean } | undefined;
out.linkedEnvironmentsBefore = settings?.linkedEnvironmentsEnabled ?? "unknown";

await updateSettings(cookie, { linkedEnvironmentsEnabled: false });
const refused = await registerPeerClient();
out.registerWhileOff = { status: refused.status, body: refused.body };

await updateSettings(cookie, { linkedEnvironmentsEnabled: true });
// A link takes a plain pairing code only: t3 refuses an access-bound (app approval) code for a link (McpOAuth.approve).
const bound = await mintPairingCode(cookie, { access: "auto-accept-edits", label: "step3 m0 bound" });
const boundRefused = await signIn(bound.code, "auto-accept-edits").then(
  () => ({ refused: false }),
  (error: { answer?: unknown }) => ({ refused: true, answer: error.answer }),
);
out.accessBoundCodeForLink = boundRefused;
const minted = await mintPairingCode(cookie, { label: "step3 m0" });
out.minted = { plain: minted.access === undefined };
const link = await signIn(minted.code, "auto-accept-edits");
out.signIn = { scope: link.scope, tokenLength: link.token.length };

const { projectId, threadId } = await createProjectAndThread(cookie, { title: "step3 m0", workspaceRoot: `/w/scratch-step3-m0-${Date.now()}` });
const mcp = new McpClient(link.token, { modeLimit: "full-access/default" });
const init = await mcp.initialize();
out.initialize = {
  status: init.status,
  contentType: init.contentType,
  sessionId: init.sessionId !== undefined,
  protocolVersion: init.message?.result?.protocolVersion,
  serverInfo: init.message?.result?.serverInfo,
};
const tools = await mcp.listTools();
out.tools = { count: tools.length, names: tools.map((tool) => tool.name).sort() };

const projects = await mcp.call("t3_project_list", {});
out.projectList = { http: projects.http, isError: projects.isError, found: projects.text.includes(projectId), sample: projects.text.slice(0, 400) };
const read = await mcp.call("t3_thread_read", { threadId });
out.threadRead = { http: read.http, isError: read.isError, sample: read.text.slice(0, 400) };

const started = Date.now();
const wait = await mcp.call("t3_thread_wait", { threadId, timeoutMs: 50_000 });
out.threadWait = { http: wait.http, isError: wait.isError, ms: Date.now() - started, sample: wait.text.slice(0, 300) };

const before = mcp.sessionId;
await admin("POST", "/_t3flare/restart");
await sleep(3000);
const afterRestart = await mcp.raw({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} });
out.afterRestartRaw = { status: afterRestart.status };
const again = await mcp.call("t3_project_list", {});
out.afterRestart = { http: again.http, isError: again.isError, reinitialised: mcp.sessionId !== before, initialisations: mcp.initialisations };

await updateSettings(cookie, { linkedEnvironmentsEnabled: false });
const off = await mcp.raw({ jsonrpc: "2.0", id: 100, method: "tools/list", params: {} });
out.whileOff = { status: off.status, text: off.text.slice(0, 200) };
await updateSettings(cookie, { linkedEnvironmentsEnabled: true });
const back = await mcp.call("t3_project_list", {});
out.backOn = { http: back.http, isError: back.isError };

writeEvidence("m0-mcp.json", out);
console.log(JSON.stringify(out, null, 1).slice(0, 4000));
