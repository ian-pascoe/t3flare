// Step 3's leak check (plan section 4.6, review C8): every secret this Environment knows, looked for in a Workspace's
// Container and in Sessions' state. Run from the admin route `POST /_t3flare/check/peer-leak`; answers names only.
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServerSecretStore from "t3/src/auth/ServerSecretStore.ts";

import { byName } from "../agents/rpc.ts";
import { workspaceRpc } from "../agents/workspaceClient.ts";
import type { EnvironmentDO } from "../environmentDO.ts";

/** What the Container shows a process: its environment, every process's, and the files a command could read. */
const CONTAINER_DUMP = [
  "{",
  'echo "== env"; env;',
  'for f in /proc/[0-9]*/environ; do echo "== $f"; tr "\\0" "\\n" < "$f"; done;',
  // Tools step: command lines too (a key on argv), and the CLIs' managed configuration (MCP entries).
  'for f in /proc/[0-9]*/cmdline; do echo "== $f"; tr "\\0" " " < "$f"; echo; done;',
  "find /workspace /tmp /root /home /etc/claude-code /etc/opencode /etc/codex -xdev -type f -size -1M -not -path '*/.git/objects/*' 2>/dev/null | head -5000 |",
  '  while read -r f; do echo "== $f"; cat "$f"; done;',
  "} 2>/dev/null | head -c 33554432",
].join(" ");

interface Secret {
  readonly name: string;
  readonly value: string;
}

/**
 * Step 3+: the T3 Connect secrets t3 keeps in its secret store: the publish credential, and the account token's access
 * and refresh tokens while held (stages; prod discards it after the link).
 */
const CONNECT_SECRETS = ["cloud-relay-environment-credential", "cloud-cli-oauth-token"];

/** The account token's stored JSON, as its two secrets. */
const tokenParts = (text: string): Array<Secret> => {
  try {
    const token = JSON.parse(text) as { accessToken?: string; refreshToken?: string };
    return [
      ...(token.accessToken ? [{ name: "access", value: token.accessToken }] : []),
      ...(token.refreshToken ? [{ name: "refresh", value: token.refreshToken }] : []),
    ];
  } catch {
    return [];
  }
};

export const connectSecrets = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const found: Array<Secret> = [];
  for (const name of CONNECT_SECRETS) {
    const value = yield* store.get(name).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    if (Option.isNone(value)) continue;
    const text = new TextDecoder().decode(value.value);
    if (name !== "cloud-cli-oauth-token") {
      found.push({ name, value: text });
      continue;
    }
    const token = tokenParts(text);
    if (token.length === 0) found.push({ name, value: text });
    for (const part of token) found.push({ name: `${name}:${part.name}`, value: part.value });
  }
  return found;
});

export const leakedIn = (text: string, secrets: ReadonlyArray<Secret>): Array<string> =>
  secrets.filter(({ value }) => text.includes(value) || value.split("\n").some((line) => line.length >= 16 && text.includes(line))).map(({ name }) => name);

export const peerLeakCheck = async (
  environment: EnvironmentDO,
  input: { readonly workspace: string; readonly threads: ReadonlyArray<string>; readonly extra?: ReadonlyArray<Secret>; readonly text?: string },
) => {
  const env = (environment as unknown as { readonly env: Record<string, unknown> }).env;
  const secrets: Array<Secret> = [];
  for (const [name, value] of Object.entries(env)) if (typeof value === "string" && value.length >= 8) secrets.push({ name, value });
  environment.github.live().forEach((value, at) => secrets.push({ name: `github-token-${at}`, value }));
  const runtime = await environment.boot("check-peer-leak");
  secrets.push(...(await runtime.run(connectSecrets)));
  const credentials: Array<string> = [];
  for (const threadId of input.threads) {
    const config = await runtime.run(Effect.flatMap(McpProviderSessions.McpProviderSessions, (sessions) => sessions.read(threadId as ThreadId)));
    if (config === undefined) continue;
    credentials.push(threadId);
    secrets.push({ name: `t3-mcp-credential:${threadId}`, value: config.authorizationHeader.replace(/^Bearer\s+/i, "") });
  }
  // Tools step (ADR-0028): the direct servers' header values, OAuth tokens and client secrets.
  secrets.push(...environment.mcpLeakSecrets());
  for (const extra of input.extra ?? []) if (extra.value.length >= 8) secrets.push(extra);
  const dump = await workspaceRpc(input.workspace).exec({ script: CONTAINER_DUMP, timeoutMs: 120_000 });
  const sessions: Array<{ readonly thread: string; readonly bytes: number; readonly leaked: Array<string> }> = [];
  for (const threadId of input.threads) {
    const session = byName(environment.agents.SESSIONS, `thread:${threadId}`, "SESSIONS");
    const text = JSON.stringify(await session.snapshot({})) + JSON.stringify(await session.diagnostics()) + JSON.stringify(await session.t3Tools());
    sessions.push({ thread: threadId, bytes: text.length, leaked: leakedIn(text, secrets) });
  }
  const container = { exitCode: dump.exitCode, bytes: dump.stdout.length, files: (dump.stdout.match(/^== \//gm) ?? []).length, leaked: leakedIn(dump.stdout, secrets) };
  // Text the caller collected (Workers Logs from `wrangler tail`, a capture endpoint's log), compared here.
  const text = input.text === undefined ? undefined : { bytes: input.text.length, leaked: leakedIn(input.text, secrets) };
  return {
    checked: secrets.map(({ name }) => name).toSorted(),
    credentialsFound: credentials.length,
    container,
    sessions,
    ...(text === undefined ? {} : { text }),
    leaked: container.leaked.length + sessions.reduce((sum, s) => sum + s.leaked.length, 0) + (text?.leaked.length ?? 0),
  };
};
