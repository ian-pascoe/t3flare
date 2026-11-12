// @effect-diagnostics globalJsonInEffect:off globalDateInEffect:off globalDate:off globalConsole:off nodeBuiltinImport:off globalFetch:off cryptoRandomUUID:off cryptoRandomUUIDInEffect:off globalTimers:off
// Evidence for ADR-0003 on a deployed stage (or local workerd): with no client, the Environment resets
// itself and later wakes on its alarm.
//
//   T3_URL=… T3_BOOTSTRAP_TOKEN=… T3FLARE_ADMIN_TOKEN=… T3FLARE_ACCESS_CLIENT_ID=… T3FLARE_ACCESS_CLIENT_SECRET=… \
//   node scripts/idle-reset.ts [--due-in-seconds 150] [--out file.json]
//
// 1. Pair (arming briefly) and, over t3's own RPC, create a project and a scheduled task due once in
//    `--due-in-seconds`: work t3 has due later, which the idle reset must set its alarm for.
// 2. Close the socket and poll the admin health route (which neither boots t3 nor counts as activity) until
//    the object has reset: a new construction, t3 stopped, the alarm set at the task's time.
// 3. Poll until the alarm has fired: t3 running again, booted by the alarm.
import { WsRpcGroup, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import * as fs from "node:fs";

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1]!;
};
const base = new URL(process.env.T3_URL ?? "http://localhost:8791");
const bootstrapToken = process.env.T3_BOOTSTRAP_TOKEN ?? "local-bootstrap-token-0123456789";
const adminToken = process.env.T3FLARE_ADMIN_TOKEN ?? "local-admin-token";
const dueInSeconds = Number(arg("due-in-seconds", "150"));
const outFile = process.argv.includes("--out") ? arg("out", "") : undefined;
const accessHeaders: Record<string, string> =
  process.env.T3FLARE_ACCESS_CLIENT_ID && process.env.T3FLARE_ACCESS_CLIENT_SECRET
    ? { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID, "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET }
    : {};

const admin = async (method: string, pathname: string) => {
  const response = await fetch(new URL(pathname, base), { method, headers: { ...accessHeaders, authorization: `Bearer ${adminToken}` } });
  return (await response.json()) as any;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const summary = (health: any) => ({
  at: new Date().toISOString(),
  runtime: health.runtime,
  constructions: health.isolate?.constructions,
  isolateBoots: health.isolate?.boots,
  objectConstructedAt: health.object?.constructedAt,
  alarm: health.alarm,
  lastBootTrigger: health.lastBoot?.trigger ?? null,
  sockets: health.activity?.sockets,
  nextDue: health.nextDue?.at ?? null,
});

const timeline: Array<unknown> = [];
await admin("POST", "/_t3flare/arm-bootstrap?minutes=2");
const pair = await fetch(new URL("/api/auth/browser-session", base), {
  method: "POST",
  headers: { "content-type": "application/json", origin: base.origin },
  body: JSON.stringify({ credential: bootstrapToken }),
});
const cookie = pair.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
await admin("POST", "/_t3flare/disarm-bootstrap");

const socketUrl = new URL("/ws?orchestrationProtocol=2", base);
socketUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
const layerProtocol = Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket({ retryTransientErrors: false })).pipe(
  Layer.provide(
    Layer.mergeAll(
      Socket.layerWebSocket(socketUrl.toString()).pipe(
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor, (url) => new WebSocket(url, { headers: { cookie, origin: base.origin } } as never)),
        ),
      ),
      RpcSerialization.layerJson,
    ),
  ),
);

const runAt = new Date(Date.now() + dueInSeconds * 1000);
const created = await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    const projectId = crypto.randomUUID();
    yield* client[WS_METHODS.projectsMutate]({
      type: "project.create",
      commandId: crypto.randomUUID(),
      projectId,
      title: "idle-reset",
      workspaceRoot: `/t3/home/idle-reset-${Date.now().toString(36)}`,
      createWorkspaceRootIfMissing: true,
    } as never);
    const task = yield* client[WS_METHODS.scheduledTasksUpsert]({
      title: "Wake the Environment",
      prompt: "A scheduled task that makes the idle reset set its alarm.",
      enabled: true,
      schedule: { type: "once", runAt: runAt.toISOString() },
      projectId,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5.5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
    } as never);
    return { projectId, task };
  }).pipe(Effect.provide(layerProtocol), Effect.scoped),
);
const startedAt = Date.now();
timeline.push({ event: "socket closed; scheduled task due", runAt: runAt.toISOString(), ...summary(await admin("GET", "/_t3flare/health")) });

let reset: any;
let woke: any;
const before = summary(await admin("GET", "/_t3flare/health"));
while (Date.now() - startedAt < (dueInSeconds + 180) * 1000) {
  await sleep(5000);
  const now = summary(await admin("GET", "/_t3flare/health"));
  if (reset === undefined && now.runtime === "stopped" && now.constructions !== before.constructions) {
    reset = now;
    timeline.push({ event: "reset (new object, t3 stopped, alarm set)", secondsAfterClose: Math.round((Date.now() - startedAt) / 1000), ...now });
  }
  if (reset !== undefined && now.runtime === "running" && now.lastBootTrigger === "alarm") {
    woke = now;
    timeline.push({ event: "woke on alarm", secondsAfterClose: Math.round((Date.now() - startedAt) / 1000), ...now });
    break;
  }
}
const result = {
  url: base.origin,
  task: (created.task as any)?.id ?? created.task,
  runAt: runAt.toISOString(),
  timeline,
  ok: reset !== undefined && woke !== undefined && reset.alarm !== null && Math.abs(new Date(reset.alarm).getTime() - runAt.getTime()) < 5000,
};
const text = JSON.stringify(result, null, 2);
console.log(text);
if (outFile) fs.writeFileSync(outFile, `${text}\n`);
process.exit(result.ok ? 0 : 1);
