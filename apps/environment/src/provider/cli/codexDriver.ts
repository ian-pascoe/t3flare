// @effect-diagnostics globalConsole:off globalConsoleInEffect:off globalJsonInEffect:off effectFnOpportunity:off
// The Codex CLI in the Cloud Environment (step 4a, plan §3, §3.1): t3's own Codex adapter (`makeCodexAdapterV2`) with
// t3flare's readiness (the image's version and the proxy's catalog, never a spawning probe), its own app-server client
// factory (a spawn in the thread's Workspace, the request guard), t3's MCP credential withheld (OD-3), text generation
// through the proxy, and the wrapper (one Workspace per session, review F1). Registered by the `builtInDrivers.ts` Shadow.
import { CodexSettings, ProviderDriverKind, type ServerProvider, type ServerProviderModel } from "@t3tools/contracts";
import { CLIS } from "@t3flare/sandbox-image/clis";
import { toWorkspace } from "@t3flare/workspace-client";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import { defaultProviderContinuationIdentity, type ProviderDriver, type ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import { haveProviderSnapshotSettingsChanged, makeProviderSnapshotSettingsSource } from "@t3tools/provider-core/server/snapshotSettings";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { type CodexAppServerClientFactoryShape, makeCodexAdapterV2 } from "t3/src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ServerConfig } from "t3/src/config.ts";

import { environmentServices } from "../../agents/bindings.ts";
import { traceProtocol } from "../../agents/processRouter.ts";
import { makePiDurableTextGeneration } from "../textGeneration.ts";
import { declinesInPlan, guardRequest } from "./codexGuard.ts";
import { t3McpForCli } from "./relayedMcp.ts";
import { type CliSession, type CliSessions, sessionFor, wrapCliAdapter } from "./wrapper.ts";

export const CODEX_DRIVER = ProviderDriverKind.make("codex");

/** t3's Codex presentation (`CodexProvider.ts` `CODEX_PRESENTATION`): every mode, `auto` with Codex's reviewer (back to stock, owner 2026-11-12). */
const PRESENTATION = {
  displayName: "Codex",
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
  reportsContextWindow: true,
} as const;

const decodeSettings = Schema.decodeSync(CodexSettings);

export type CodexCliDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Digest.Digest
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderContinuationRequests.ProviderContinuationRequests
  | ServerConfig;

/** The catalog's models as Codex lists them: the real id is the slug Codex sends (M0 P3: every family drives tools). */
export const codexModels = (): ReadonlyArray<ServerProviderModel> =>
  environmentServices()
    .catalog.current()
    .models.map((model) => ({ slug: model.id, name: model.name, subProvider: model.vendor, isCustom: false, capabilities: { optionDescriptors: [] } }));

const refusedError = (method: string, why: string) => new CodexErrors.CodexAppServerRequestError({ code: -32601, errorMessage: why, method });

/** The client t3's adapter talks to: every request through the guard, plan mode's file changes declined. */
export const guardClient = (client: CodexClient.CodexAppServerClient["Service"], session: CliSession): CodexClient.CodexAppServerClient["Service"] => {
  const context = () => ({
    ...(session.runtimeMode === undefined ? {} : { runtimeMode: session.runtimeMode }),
    ...(session.interactionMode === undefined ? {} : { interactionMode: session.interactionMode }),
    sandbox: session.process?.sandbox === true,
  });
  const guarded = <A, E>(method: string, params: unknown, send: (params: never) => Effect.Effect<A, E>) => {
    const answer = guardRequest(method, params, context());
    if ("refused" in answer) {
      console.warn(JSON.stringify({ t3flare: "codex-request-refused", method }));
      return Effect.fail(refusedError(method, answer.refused));
    }
    const sent = send(answer.params as never);
    // The resume proof (M5): Codex resumed this native thread itself, not a handoff.
    if (method !== "thread/resume") return sent;
    const threadId = (answer.params as { threadId?: unknown }).threadId;
    return sent.pipe(
      Effect.tap(() => Effect.sync(() => traceProtocol("codex", "thread/resume", `ok ${String(threadId)}`))),
      Effect.tapError((error) => Effect.sync(() => traceProtocol("codex", "thread/resume", `failed ${String(threadId)}: ${String(error).slice(0, 200)}`))),
    );
  };
  return {
    ...client,
    request: ((method: string, payload: unknown) => guarded(method, payload, (params) => client.request(method as never, params))) as typeof client.request,
    raw: { ...client.raw, request: ((method: string, payload: unknown) => guarded(method, payload, (params) => client.raw.request(method as never, params))) as typeof client.raw.request },
    handleServerRequest: ((method: string, handler: (payload: unknown) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>) =>
      client.handleServerRequest(method as never, ((payload: unknown) =>
        declinesInPlan(method) && session.interactionMode === "plan" ? Effect.succeed({ decision: "decline" }) : handler(payload)) as never)) as typeof client.handleServerRequest,
  };
};

/** Spawns `codex app-server` in the thread's Workspace (cwd: t3's spawn has none) and guards its client. */
export const cliClientFactory = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], sessions: CliSessions): CodexAppServerClientFactoryShape => ({
  open: Effect.fn("CodexCliDriver.open")(function* (input) {
      const cwd = input.runtimePolicy.cwd;
      const openError = (cause: unknown) => new ProviderAdapter.ProviderAdapterOpenSessionError({ driver: CODEX_DRIVER, providerSessionId: input.providerSessionId, cause });
      if (cwd === null || toWorkspace(cwd) === null) return yield* openError("t3flare: Codex runs in a Workspace's Container; start the thread in a project");
      const session = sessionFor(sessions, input.providerSessionId, cwd, input.threadId);
      session.runtimeMode = input.runtimePolicy.runtimeMode;
      session.interactionMode = input.runtimePolicy.interactionMode;
      const handle = yield* spawner
        .spawn(ChildProcess.make("codex", ["app-server"], { cwd, env: { T3CODE_THREAD_ID: input.threadId }, stdin: { stream: "pipe", endOnDone: false } }))
        .pipe(Effect.mapError(openError));
      const context = yield* Layer.build(CodexClient.layerChildProcess(handle, {}));
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context));
      return guardClient(client, session);
  }),
});

const snapshotOf = (enabled: boolean, setupMode: string | undefined) =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const managed = setupMode === "managed";
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled,
      checkedAt,
      models: codexModels(),
      probe: managed
        ? { installed: true, version: CLIS.codex.version, status: "error", auth: { status: "unauthenticated" }, message: "ChatGPT sign-in is not offered; t3flare uses the model proxy (set Codex's setup mode back)." }
        : { installed: true, version: CLIS.codex.version, status: "ready", auth: { status: "authenticated" } },
    });
  });

export const CodexCliDriver: ProviderDriver<CodexSettings, CodexCliDriverEnv> = {
  driverKind: CODEX_DRIVER,
  metadata: { displayName: "Codex", supportsMultipleInstances: false, hasDefaultInstance: true },
  configSchema: CodexSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("CodexCliDriver.create")(function* ({ instanceId, displayName, accentColor, enabled, config }) {
    const continuationIdentity = defaultProviderContinuationIdentity({ driverKind: CODEX_DRIVER, instanceId });
    const stamp = (draft: Omit<ServerProvider, "instanceId" | "driver">): ServerProvider => ({
      ...draft,
      instanceId,
      driver: CODEX_DRIVER,
      ...(displayName ? { displayName } : {}),
      ...(accentColor ? { accentColor } : {}),
      continuation: { groupKey: continuationIdentity.continuationKey },
    });
    const effective = { ...config, enabled };
    const { catalog } = environmentServices();
    const settingsSource = yield* makeProviderSnapshotSettingsSource(effective);
    const maintenance = makeManualOnlyProviderMaintenanceCapabilities({ provider: CODEX_DRIVER, packageName: null });
    const snapshot = yield* makeManagedServerProvider({
      resolveMaintenance: () => Effect.succeed(maintenance),
      getSettings: settingsSource.getSettings,
      streamSettings: settingsSource.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) => snapshotOf(settings.provider.enabled, config.setupMode).pipe(Effect.map(stamp)),
      checkProvider: Effect.promise(() => catalog.refresh()).pipe(
        Effect.flatMap(() => snapshotOf(effective.enabled, config.setupMode)),
        Effect.map(stamp),
      ),
    }).pipe(Effect.orDie);
    yield* Effect.forkScoped(snapshot.refresh);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const realMcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const sessions: CliSessions = new Map();
    // t3's own tools with t3's per-thread bearer, as stock t3 hands them, at t3's public `/mcp` (owner, 2026-11-12, back
    // to stock; relayedMcp.ts).
    const relayed = t3McpForCli(realMcpSessions, () => environmentServices().t3McpUrl());
    // binaryPath, homePath and launchArgs are not used: the image's binary and the CLI profile decide (plan §3).
    const settings = { ...config, enabled, setupMode: "existing" as const, binaryPath: "codex", homePath: "", launchArgs: "" } satisfies CodexSettings;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const adapter = yield* makeCodexAdapterV2({
      instanceId,
      settings,
      environment: {},
      clientFactory: cliClientFactory(spawner, sessions),
      digest: yield* Digest.Digest,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig,
      continuationRequests,
    }).pipe(Effect.provideService(McpProviderSessions.McpProviderSessions, relayed));
    return {
      instanceId,
      driverKind: CODEX_DRIVER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled: enabled && config.setupMode !== "managed",
      snapshot,
      orchestrationAdapter: wrapCliAdapter(adapter, { sessions }),
      textGeneration: makePiDurableTextGeneration(),
    } satisfies ProviderInstance;
  }),
};
