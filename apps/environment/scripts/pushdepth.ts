// @effect-diagnostics globalDate:off globalConsole:off globalConsoleInEffect:off nodeBuiltinImport:off
// The Session push depth check (ADR-0005, 2026-11-21 refinement): tool-using turns in a row in one Durable agent's
// thread all complete. Before the refinement, each round trip between the Environment and a Session nested the next one
// level deeper, until a turn failed with "Subrequest depth limit exceeded" ("did not answer open").
//
// The turns are sent as a client sends them: all on one WebSocket, opened first, with nothing else reaching the
// Environment while they run. A new request to the Environment (a socket per command, an HTTP read) becomes its newest
// request and starts the depth again from the top, which hides the nesting; so the thread is read once, at the end.
// The bounded snapshot read at the end keeps the latest 12 runs, so at most 12 turns are checked.
//
//   node scripts/stage.ts deploy pushdepth
//   node scripts/stage.ts run pushdepth pushdepth [--turns 12] [--turn-ms 25000] [--out file.json]
import * as fs from "node:fs";

import { ORCHESTRATION_V2_WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/rpc";

import { ensureProject } from "./lib/cliTurn.ts";
import { DEFAULT_MODEL, enablePiDurable, itemsOf, pair, projectionOf, protocol, runsOf, threadWindow, uuid, wsCall } from "./lib/client.ts";

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const turns = Math.min(12, Number(arg("--turns") ?? 12));
const turnMs = Number(arg("--turn-ms") ?? 25_000);
const out = arg("--out");

const cookie = await pair();
await enablePiDurable(cookie);
// As the Owner's prod has it: after each completed turn the Environment asks the Session for a suggestion while it
// handles the Session's push, a call back into the Session on every turn.
await wsCall(cookie, "server.updateSettings", { patch: { promptSuggestionsEnabled: true } });
const stamp = Date.now().toString(36);
// A Workspace (the fixture repo's clone), so the turns' commands have a Container to run in.
const { projectId } = await ensureProject(cookie, `pushdepth-${stamp}`);
const threadId = uuid();
console.log(`thread ${threadId}`);

const command = (fields: Record<string, unknown>) => ({ commandId: uuid(), ...fields }) as never;
await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    const send = client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand];
    yield* send(
      command({
        type: "thread.create",
        threadId,
        projectId,
        title: `pushdepth ${stamp}`,
        modelSelection: DEFAULT_MODEL,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      }),
    );
    for (let turn = 1; turn <= turns; turn++) {
      yield* send(
        command({
          type: "message.dispatch",
          threadId,
          messageId: uuid(),
          text: `Run the shell command \`echo turn-${turn}\` with your bash tool, then reply with its output and nothing else.`,
          attachments: [],
          modelSelection: DEFAULT_MODEL,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        }),
      );
      console.log(`turn ${turn} sent`);
      yield* Effect.sleep(`${turnMs} millis`);
    }
  }).pipe(Effect.provide(protocol(cookie)), Effect.scoped),
);

const projection = projectionOf(await threadWindow(cookie, threadId));
const runs = runsOf(projection).map((run) => run.status);
// Every turn the snapshot still shows (it keeps the latest items too) ran its command and answered with the output.
const items = itemsOf(projection);
const textsOf = (type: string) => items.filter((item: any) => item.type === type).map((item: any) => String(item.text ?? ""));
const exact = (marker: string) => new RegExp(`\\b${marker}\\b`);
const markers = textsOf("user_message").flatMap((text) => text.match(/turn-\d+/) ?? []);
const ran = items
  .filter((item: any) => item.type === "command_execution")
  .map((item: any) => String(item.input ?? item.title ?? ""));
const missing = markers.filter(
  (marker) =>
    !ran.some((input) => exact(marker).test(input)) ||
    !textsOf("assistant_message").some((text) => exact(marker).test(text)),
);
const failures = items.filter((item: any) => item.type === "error").map((item: any) => item.failure?.message ?? item.title);
const ok =
  runs.length === turns &&
  runs.every((status) => status === "completed") &&
  markers.length > 0 &&
  missing.length === 0 &&
  failures.length === 0;
const report = { at: new Date().toISOString(), threadId, turns, runs, checkedTurns: markers.length, missing, failures, ok };
if (out !== undefined) fs.writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
console.log(ok ? `ok: ${turns} turns completed, each with its command's output` : `FAILED: ${JSON.stringify(report)}`);
process.exit(ok ? 0 : 1);
