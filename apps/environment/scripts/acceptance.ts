// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off globalFetch:off
// The step 0 acceptance test, headless: pair with the bootstrap token, open t3's RPC
// socket, create a scratch project and a thread, list threads, and open the thread's
// live stream. Talks to the Environment exactly as a stock client does (t3's contracts
// and Effect RPC over the WebSocket), without a browser.
//
//   T3_URL=https://… T3_BOOTSTRAP_TOKEN=… bun scripts/acceptance.ts [--threads 120]
import { WsRpcGroup, WS_METHODS, ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Duration from "effect/Duration";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

const base = new URL(process.env.T3_URL ?? "http://localhost:8791");
const token = process.env.T3_BOOTSTRAP_TOKEN ?? "local-bootstrap-token-0123456789";
const threadsArg = process.argv.indexOf("--threads");
const extraThreads = threadsArg === -1 ? 0 : Number(process.argv[threadsArg + 1]);

const report: Record<string, unknown> = { url: base.origin };
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

// 1. Discover and pair (the web client's /pair#token=… does the same browser-session exchange).
const descriptorRes = await fetch(new URL("/.well-known/t3/environment", base));
const descriptor = (await descriptorRes.json()) as Record<string, any>;
report.descriptor = { status: descriptorRes.status, machine: descriptor.platform?.machine, label: descriptor.label };
const pair = await fetch(new URL("/api/auth/browser-session", base), {
  method: "POST",
  headers: { "content-type": "application/json", origin: base.origin },
  body: JSON.stringify({ credential: token }),
});
const pairBody = (await pair.json()) as Record<string, any>;
const cookie = pair.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
report.pairing = { status: pair.status, ms: ms(), scopes: pairBody.scopes, permissions: pairBody.permissions, sessionMethod: pairBody.sessionMethod, expiresAt: pairBody.expiresAt };
if (pair.status !== 200) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

const socketUrl = new URL("/ws?orchestrationProtocol=2", base);
socketUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";

const layerProtocol = Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket({ retryTransientErrors: false })).pipe(
  Layer.provide(
    Layer.mergeAll(
      Socket.layerWebSocket(socketUrl.toString()).pipe(
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor, (url) =>
            // Bun's WebSocket takes handshake headers: the session cookie and the page origin.
            new WebSocket(url, { headers: { cookie, origin: base.origin } } as never),
          ),
        ),
      ),
      RpcSerialization.layerJson,
    ),
  ),
);

const first = <A, E, R>(stream: Stream.Stream<A, E, R>, label: string) =>
  Stream.runHead(stream).pipe(
    Effect.timeout(Duration.seconds(20)),
    Effect.map((value) => ({ label, ok: value._tag === "Some", ms: ms(), value: value._tag === "Some" ? value.value : undefined })),
  );

const uuid = () => crypto.randomUUID();

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);
  const config = yield* first(client[WS_METHODS.subscribeServerConfig]({}), "subscribeServerConfig");
  const shell0 = yield* first(client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}), "subscribeShell");
  report.connect = { serverConfig: { ok: config.ok, ms: config.ms }, shell: { ok: shell0.ok, ms: shell0.ms } };

  const stamp = Date.now().toString(36);
  const projectId = uuid();
  const created = yield* client[WS_METHODS.projectsMutate]({
    type: "project.create",
    commandId: uuid(),
    projectId,
    title: `scratch-${stamp}`,
    workspaceRoot: `/t3/home/scratch-${stamp}`,
    createWorkspaceRootIfMissing: true,
  } as never);
  report.project = { projectId, ms: ms(), result: created };

  const createThread = (title: string) => {
    const threadId = uuid();
    return client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
      type: "thread.create",
      commandId: uuid(),
      threadId,
      projectId,
      title,
      modelSelection: { instanceId: "codex", model: "gpt-5.5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    } as never).pipe(Effect.as(threadId));
  };
  const threadId = yield* createThread(`spike thread ${stamp}`);
  report.thread = { threadId, ms: ms() };

  if (extraThreads > 0) {
    const started = ms();
    yield* Effect.forEach(Array.from({ length: extraThreads }, (_, i) => i), (i) => createThread(`fixture ${stamp} ${i}`), {
      concurrency: 8,
      discard: true,
    });
    report.fixture = { threads: extraThreads, ms: ms() - started };
  }

  const shell = yield* first(client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}), "subscribeShell (after)");
  const snapshot = shell.value as any;
  const threads: Array<any> = snapshot?.snapshot?.threads ?? snapshot?.threads ?? [];
  report.listThreads = {
    ms: shell.ms,
    kind: snapshot?._tag ?? snapshot?.type,
    threadCount: threads.length,
    containsNewThread: JSON.stringify(snapshot ?? {}).includes(threadId),
  };

  const detail = yield* first(client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId } as never), "subscribeThread");
  report.openThread = {
    ok: detail.ok,
    ms: detail.ms,
    kind: (detail.value as any)?._tag ?? (detail.value as any)?.type,
    containsTitle: JSON.stringify(detail.value ?? {}).includes(`spike thread ${stamp}`),
  };
});

const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layerProtocol), Effect.scoped));
report.ok = exit._tag === "Success";
if (exit._tag === "Failure") report.failure = String(exit.cause);
report.totalMs = ms();
console.log(JSON.stringify(report, (key, value) => (key === "value" ? undefined : value), 2));
process.exit(report.ok ? 0 : 1);
