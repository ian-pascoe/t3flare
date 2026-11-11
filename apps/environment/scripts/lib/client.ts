// @effect-diagnostics globalJsonInEffect:off globalDateInEffect:off globalDate:off globalConsole:off globalFetch:off cryptoRandomUUID:off globalTimers:off anyUnknownInErrorContext:off
// A headless stock-protocol t3 client for the stage scripts (step 2a): pairs with the armed bootstrap token, sends
// commands over /ws (t3's own WsRpcGroup), and reads threads through the bounded HTTP snapshot.
import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

export const base = new URL(process.env.T3_URL ?? "http://localhost:8791");
const bootstrapToken = process.env.T3_BOOTSTRAP_TOKEN ?? "local-bootstrap-token-0123456789";
const adminToken = process.env.T3FLARE_ADMIN_TOKEN ?? "local-admin-token";
const accessHeaders: Record<string, string> =
  process.env.T3FLARE_ACCESS_CLIENT_ID && process.env.T3FLARE_ACCESS_CLIENT_SECRET
    ? { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID, "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET }
    : {};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const uuid = () => crypto.randomUUID();

export const admin = async (method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const response = await fetch(new URL(pathname, base), {
    method,
    redirect: "manual",
    headers: { ...accessHeaders, authorization: `Bearer ${adminToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch {
    return { status: response.status, json: text.slice(0, 500) };
  }
};

/** Arms pairing and pairs: the session cookie of a browser client. */
export const pair = async (): Promise<string> => {
  await admin("POST", "/_t3flare/arm-bootstrap?minutes=15");
  const response = await fetch(new URL("/api/auth/browser-session", base), {
    method: "POST",
    headers: { "content-type": "application/json", origin: base.origin },
    body: JSON.stringify({ credential: bootstrapToken }),
  });
  if (response.status !== 200) throw new Error(`pairing failed: ${response.status} ${await response.text()}`);
  return response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};

export const protocol = (cookie: string) => {
  const socketUrl = new URL("/ws?orchestrationProtocol=2", base);
  socketUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket({ retryTransientErrors: false })).pipe(
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
};

/** Opens a /ws client for one call and closes it: the Environment sees a client only while a command is sent. */
export const dispatch = (cookie: string, command: Record<string, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      return yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command as never);
    }).pipe(Effect.provide(protocol(cookie)), Effect.scoped),
  );

/** One WS method's answer (any of t3's `WS_METHODS`), on a socket opened for the call. */
export const wsCall = (cookie: string, method: string, payload: unknown): Promise<unknown> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = (yield* RpcClient.make(WsRpcGroup)) as unknown as Record<string, (input: unknown) => Effect.Effect<unknown, unknown>>;
      return yield* client[method]!(payload);
    }).pipe(Effect.provide(protocol(cookie)), Effect.scoped),
  );

/** Every event of a streaming WS method, until it ends. */
export const wsStream = (cookie: string, method: string, payload: unknown): Promise<ReadonlyArray<unknown>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = (yield* RpcClient.make(WsRpcGroup)) as unknown as Record<string, (input: unknown) => Stream.Stream<unknown, unknown>>;
      return yield* Stream.runCollect(client[method]!(payload));
    }).pipe(Effect.provide(protocol(cookie)), Effect.scoped),
  ).then((chunk) => [...chunk]);

/** The first event of a streaming WS method (a subscription's snapshot), on a socket opened for the call. */
export const wsFirst = (cookie: string, method: string, payload: unknown): Promise<unknown> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = (yield* RpcClient.make(WsRpcGroup)) as unknown as Record<string, (input: unknown) => Stream.Stream<unknown, unknown>>;
      return yield* Stream.runHead(client[method]!(payload));
    }).pipe(Effect.provide(protocol(cookie)), Effect.scoped),
  ).then((head) => (head._tag === "Some" ? head.value : undefined));

export const updateSettings = (cookie: string, patch: Record<string, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      return yield* client[WS_METHODS.serverUpdateSettings]({ patch } as never);
    }).pipe(Effect.provide(protocol(cookie)), Effect.scoped),
  );

export const mutateProject = (cookie: string, command: Record<string, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      return yield* client[WS_METHODS.projectsMutate](command as never);
    }).pipe(Effect.provide(protocol(cookie)), Effect.scoped),
  );

/** The thread's projection, through the bounded HTTP snapshot the web client reads. */
export const threadWindow = async (cookie: string, threadId: string): Promise<any> => {
  const response = await fetch(new URL(`/api/orchestration/threads/${threadId}/bounded`, base), {
    headers: { cookie, "x-t3-orchestration-protocol": "2" },
  });
  if (response.status !== 200) throw new Error(`thread window ${response.status}`);
  return response.json();
};

/** Finds the projection inside the bounded snapshot's answer, whatever wraps it. */
export const projectionOf = (window: any): any => window?.projection ?? window?.snapshot?.projection ?? window;

export const DEFAULT_MODEL = { instanceId: "piDurable", model: "anthropic/claude-haiku-5-5", options: [{ id: "thinking", value: "low" }] };

export const createProjectAndThread = async (
  cookie: string,
  options: { readonly title: string; readonly workspaceRoot: string; readonly runtimeMode?: string },
) => {
  const projectId = uuid();
  await mutateProject(cookie, {
    type: "project.create",
    commandId: uuid(),
    projectId,
    title: options.title,
    workspaceRoot: options.workspaceRoot,
    createWorkspaceRootIfMissing: true,
  });
  const threadId = uuid();
  await dispatch(cookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId,
    projectId,
    title: options.title,
    modelSelection: DEFAULT_MODEL,
    runtimeMode: options.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return { projectId, threadId };
};

export const sendMessage = (cookie: string, threadId: string, text: string, model = DEFAULT_MODEL, extra: Record<string, unknown> = {}) => {
  const messageId = uuid();
  return dispatch(cookie, {
    type: "message.dispatch",
    commandId: uuid(),
    threadId,
    messageId,
    text,
    attachments: [],
    modelSelection: model,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
    ...extra,
  }).then(() => messageId);
};

export interface RunView {
  readonly id: string;
  readonly status: string;
  readonly restartContinuationOfRunId?: string;
}

export const runsOf = (projection: any): Array<RunView> => projection?.runs ?? [];
export const itemsOf = (projection: any): Array<any> => projection?.turnItems ?? [];

/** Polls until `done(projection)` holds or `timeoutMs` passes. */
export const waitFor = async (cookie: string, threadId: string, done: (projection: any) => boolean, timeoutMs = 180_000) => {
  const started = Date.now();
  let projection: any;
  while (Date.now() - started < timeoutMs) {
    // A window read while the Environment boots again (an idle reset, a restart) can fail: read it again.
    const window = await threadWindow(cookie, threadId).catch(() => undefined);
    if (window === undefined) {
      await sleep(1000);
      continue;
    }
    projection = projectionOf(window);
    if (done(projection)) return { projection, ms: Date.now() - started };
    await sleep(1000);
  }
  throw new Error(`timed out after ${timeoutMs} ms; runs: ${JSON.stringify(runsOf(projection).map((r) => r.status))}`);
};

export const SETTLED = new Set(["completed", "failed", "interrupted", "cancelled"]);
