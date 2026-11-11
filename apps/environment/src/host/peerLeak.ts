// Step 3's leak check (plan section 4.6, review C8): every secret this Environment knows, looked for in a Workspace's
// Container and in Sessions' state. Run from the admin route `POST /_t3flare/check/peer-leak`; answers names only.
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { byName } from "../agents/rpc.ts";
import { workspaceRpc } from "../agents/workspaceClient.ts";
import type { EnvironmentDO } from "../environmentDO.ts";

/** What the Container shows a process: its environment, every process's, and the files a command could read. */
const CONTAINER_DUMP = [
  "{",
  'echo "== env"; env;',
  'for f in /proc/[0-9]*/environ; do echo "== $f"; tr "\\0" "\\n" < "$f"; done;',
  "find /workspace /tmp /root /home -xdev -type f -size -1M -not -path '*/.git/objects/*' 2>/dev/null | head -5000 |",
  '  while read -r f; do echo "== $f"; cat "$f"; done;',
  "} 2>/dev/null | head -c 33554432",
].join(" ");

interface Secret {
  readonly name: string;
  readonly value: string;
}

const leakedIn = (text: string, secrets: ReadonlyArray<Secret>): Array<string> =>
  secrets.filter(({ value }) => text.includes(value) || value.split("\n").some((line) => line.length >= 16 && text.includes(line))).map(({ name }) => name);

export const peerLeakCheck = async (
  environment: EnvironmentDO,
  input: { readonly workspace: string; readonly threads: ReadonlyArray<string>; readonly extra?: ReadonlyArray<Secret> },
) => {
  const env = (environment as unknown as { readonly env: Record<string, unknown> }).env;
  const secrets: Array<Secret> = [];
  for (const [name, value] of Object.entries(env)) if (typeof value === "string" && value.length >= 8) secrets.push({ name, value });
  environment.github.live().forEach((value, at) => secrets.push({ name: `github-token-${at}`, value }));
  const runtime = await environment.boot("check-peer-leak");
  const credentials: Array<string> = [];
  for (const threadId of input.threads) {
    const config = await runtime.run(Effect.flatMap(McpProviderSessions.McpProviderSessions, (sessions) => sessions.read(threadId as ThreadId)));
    if (config === undefined) continue;
    credentials.push(threadId);
    secrets.push({ name: `t3-mcp-credential:${threadId}`, value: config.authorizationHeader.replace(/^Bearer\s+/i, "") });
  }
  for (const extra of input.extra ?? []) if (extra.value.length >= 8) secrets.push(extra);
  const dump = await workspaceRpc(input.workspace).exec({ script: CONTAINER_DUMP, timeoutMs: 120_000 });
  const sessions: Array<{ readonly thread: string; readonly bytes: number; readonly leaked: Array<string> }> = [];
  for (const threadId of input.threads) {
    const session = byName(environment.agents.SESSIONS, `thread:${threadId}`, "SESSIONS");
    const text = JSON.stringify(await session.snapshot({})) + JSON.stringify(await session.diagnostics()) + JSON.stringify(await session.t3Tools());
    sessions.push({ thread: threadId, bytes: text.length, leaked: leakedIn(text, secrets) });
  }
  const container = { exitCode: dump.exitCode, bytes: dump.stdout.length, files: (dump.stdout.match(/^== \//gm) ?? []).length, leaked: leakedIn(dump.stdout, secrets) };
  return {
    checked: secrets.map(({ name }) => name).toSorted(),
    credentialsFound: credentials.length,
    container,
    sessions,
    leaked: container.leaked.length + sessions.reduce((sum, s) => sum + s.leaked.length, 0),
  };
};
