// Our composition root for t3's server (ADR-0001): the layer graph of
// t3code/apps/server/src/server.ts, with the Node platform swapped for the Durable
// Object's and the host-bound features left out or stubbed. server.ts's layers are
// module-private, so this file restates the ones we keep; each departure is marked
// `t3flare:`.
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { RepositoryIdentity } from "@t3tools/contracts";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as NetService from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { MuseUsageHome } from "@t3tools/provider-muse/server";
import * as CursorAccountReader from "@t3tools/provider-cursor/server/CursorAccountReader";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentKeys from "t3/src/cloud/environmentKeys.ts";
import * as AssetSigner from "t3/src/assets/AssetSigner.ts";
import * as DatabaseStorage from "t3/src/persistence/DatabaseStorage.ts";
import * as StorageCleanup from "t3/src/storageCleanup.ts";
import * as PullRequestSyncReactor from "t3/src/orchestration-v2/PullRequestSyncReactor.ts";
import * as PullRequestWatchReactor from "t3/src/orchestration-v2/PullRequestWatchReactor.ts";
import * as DelegatedTaskQuestionReactor from "t3/src/orchestration-v2/DelegatedTaskQuestionReactor.ts";
import * as BackgroundPolicy from "t3/src/background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "t3/src/background/HostPowerMonitor.ts";
import * as ServerConfig from "t3/src/config.ts";
import * as ServerHttp from "t3/src/http.ts";
import * as Ws from "t3/src/ws.ts";
import * as AgentScopeLive from "t3/src/process/agentScope.ts";
import * as ExternalLauncher from "t3/src/process/externalLauncher.ts";
import * as PullRequestHttp from "t3/src/pullRequest/http.ts";
import * as SpeechModelStore from "t3/src/speech/SpeechModelStore.ts";
import * as SpeechService from "t3/src/speech/SpeechService.ts";
import * as CloudSpeech from "t3/src/speech/CloudSpeech.ts";
import { speechHttpApiLayer } from "t3/src/speech/http.ts";
import * as PullRequestProviderRegistry from "t3/src/pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestService from "t3/src/pullRequest/PullRequestService.ts";
import * as PullRequestFilesViewed from "t3/src/persistence/PullRequestFilesViewed.ts";
import * as PullRequestReviewGuides from "t3/src/persistence/PullRequestReviewGuides.ts";
import * as PullRequestReviewGuideService from "t3/src/pullRequest/PullRequestReviewGuideService.ts";
import * as ServerLifecycleEvents from "t3/src/serverLifecycleEvents.ts";
import * as AnalyticsService from "t3/src/telemetry/AnalyticsService.ts";
import * as DelegatedTaskAnalytics from "t3/src/telemetry/DelegatedTaskAnalytics.ts";
import * as ProviderUsageAnalytics from "t3/src/telemetry/ProviderUsageAnalytics.ts";
import * as ModelManifest from "t3/src/provider/ModelManifest.ts";
import * as ResetCreditCoordinator from "t3/src/provider/resetCreditCoordinator.ts";
import * as ProviderHostLive from "t3/src/provider/ProviderHostLive.ts";
import * as DocumentText from "t3/src/provider/DocumentText.ts";
import * as CheckpointDiffQuery from "t3/src/checkpointing/CheckpointDiffQuery.ts";
import * as NativeChildWorkQuery from "t3/src/orchestration-v2/NativeChildWorkQuery.ts";
import * as CheckpointStore from "t3/src/checkpointing/CheckpointStore.ts";
import * as SourceControlBuiltInDrivers from "t3/src/sourceControl/builtInDrivers.ts";
import * as SourceControlSignIn from "t3/src/sourceControl/SourceControlSignIn.ts";
import { BUILT_IN_SOURCE_CONTROL_DRIVER_LIST } from "t3/src/sourceControl/sourceControlDefinitions.ts";
import * as TextGeneration from "t3/src/textGeneration/TextGeneration.ts";
import * as SecretResolver from "t3/src/secrets/SecretResolver.ts";
import * as ProviderInstanceRegistryHydration from "t3/src/provider/ProviderInstanceRegistryHydration.ts";
import * as ProjectSettingsOverrideSweep from "t3/src/provider/ProjectSettingsOverrideSweep.ts";
import * as TerminalLayer from "../terminal/layer.ts";
import * as McpHttpServer from "t3/src/mcp/McpHttpServer.ts";
import * as PeerForwarding from "t3/src/peer/PeerForwarding.ts";
import * as RemoteDelegation from "t3/src/peer/RemoteDelegation.ts";
import * as PeerLinkRequests from "t3/src/peer/PeerLinkRequests.ts";
import * as PeerLinks from "t3/src/peer/PeerLinks.ts";
import * as PeerMcpClient from "t3/src/peer/PeerMcpClient.ts";
import * as McpSessionRegistry from "t3/src/mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "t3/src/mcp/PreviewAutomationBroker.ts";
import * as DeviceService from "t3/src/device/DeviceService.ts";
import * as PreviewManager from "t3/src/preview/Manager.ts";
import * as PortScanner from "t3/src/preview/PortScanner.ts";
import * as ServerBrowser from "t3/src/preview/ServerBrowser.ts";
import * as PreviewAgentActivity from "t3/src/preview/PreviewAgentActivity.ts";
import * as DesktopBrowserChannel from "t3/src/preview/DesktopBrowserChannel.ts";
import * as PreviewBrowser from "t3/src/preview/PreviewBrowser.ts";
import * as ProcessRunner from "t3/src/processRunner.ts";
import * as GitManager from "t3/src/git/GitManager.ts";
import * as EnvironmentTheme from "t3/src/environmentTheme.ts";
import * as Keybindings from "t3/src/keybindings.ts";
import * as ServerRuntimeStartup from "t3/src/serverRuntimeStartup.ts";
import * as AgentAwarenessRelay from "t3/src/relay/AgentAwarenessRelay.ts";
import * as ServerSettings from "t3/src/serverSettings.ts";
import * as ProjectEnrichmentService from "t3/src/project/ProjectEnrichmentService.ts";
import * as NativeAppIconResolver from "t3/src/assets/NativeAppIconResolver.ts";
import * as AntigravityInstallation from "t3/src/provider/AntigravityInstallation.ts";
import * as ProviderInstallation from "t3/src/provider/providerInstallation.ts";
import * as CodexInstallation from "t3/src/provider/CodexInstallation.ts";
import * as ProviderInstanceRegistry from "t3/src/provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapterRegistry from "t3/src/orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "t3/src/provider/ProviderRegistry.ts";
import * as ProviderUsageLimitsIngestion from "t3/src/provider/ProviderUsageLimitsIngestion.ts";
import * as UsageLimitSources from "t3/src/usage/UsageLimitSources.ts";
import * as ProjectFaviconResolver from "t3/src/project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "t3/src/project/T3ProjectFileLoader.ts";
import * as RepositoryIdentityResolver from "t3/src/project/RepositoryIdentityResolver.ts";
import * as WorkspaceEntries from "t3/src/workspace/WorkspaceEntries.ts";
import * as KnownWorkspaces from "t3/src/workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "t3/src/workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "t3/src/workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "t3/src/vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "t3/src/vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "t3/src/vcs/VcsProjectConfig.ts";
import * as VcsProcess from "t3/src/vcs/VcsProcess.ts";
import * as VcsProvisioningService from "t3/src/vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "t3/src/vcs/VcsStatusBroadcaster.ts";
import * as ProjectCloneTracker from "t3/src/project/ProjectCloneTracker.ts";
import * as GitWorkflowService from "t3/src/git/GitWorkflowService.ts";
import * as ReviewService from "t3/src/review/ReviewService.ts";
import * as SourceControlProviderRegistry from "t3/src/sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequestReadCache from "t3/src/pullRequest/PullRequestReadCache.ts";
import * as SourceControlRepositoryService from "t3/src/sourceControl/SourceControlRepositoryService.ts";
import * as WorktreeSetupTracker from "t3/src/project/WorktreeSetupTracker.ts";
import * as Observability from "t3/src/observability/Observability.ts";
import * as ServerEnvironment from "t3/src/environment/ServerEnvironment.ts";
import * as DirectEndpoints from "t3/src/environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "t3/src/environment/RemoteOpenTargets.ts";
import * as AuthHttp from "t3/src/auth/http.ts";
import * as ReplayMarkers from "t3/src/auth/replayMarkers.ts";
import * as CodexManagedTokenBroker from "t3/src/provider/CodexManagedTokenBroker.ts";
import * as WebhookRoute from "t3/src/scheduledTasks/webhookRoute.ts";
import * as RelayDeliveryProof from "t3/src/scheduledTasks/RelayDeliveryProof.ts";
import * as HeldHooksWaker from "t3/src/relay/HeldHooksWaker.ts";
import * as McpOAuth from "t3/src/auth/McpOAuth.ts";
import * as McpOAuthHttp from "t3/src/auth/mcpOAuthHttp.ts";
import { ScheduledTaskWebhookOrigin } from "t3/src/scheduledTasks/ScheduledTaskService.ts";
import * as EnvironmentAuth from "t3/src/auth/EnvironmentAuth.ts";
import * as CloudHttp from "t3/src/cloud/http.ts";
import * as CloudLink from "t3/src/cloud/CloudLink.ts";
import * as ConnectReachability from "t3/src/cloud/ConnectReachability.ts";
import * as RelayTracing from "t3/src/cloud/relayTracing.ts";
import * as CloudManagedEndpointRuntime from "t3/src/cloud/ManagedEndpointRuntime.ts";
import * as CloudCliTokenManager from "t3/src/cloud/CliTokenManager.ts";
import * as ServerSelfUpdate from "t3/src/cloud/selfUpdate.ts";
import * as DesktopAppUpdate from "t3/src/desktopUpdate/DesktopAppUpdate.ts";
import * as ServiceLauncherClient from "t3/src/cloud/serviceLauncherClient.ts";
import * as ProcessDiagnostics from "t3/src/diagnostics/ProcessDiagnostics.ts";
import * as HostResources from "t3/src/resourceTelemetry/HostResources.ts";
import * as ProcessResourceMonitor from "t3/src/diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "t3/src/diagnostics/TraceDiagnostics.ts";
import * as TriageService from "t3/src/triage/TriageService.ts";
import * as DesktopTelemetryReceiver from "t3/src/resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "t3/src/resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "t3/src/resourceTelemetry/ResourceAttribution.ts";
import * as ResourceMonitorBinary from "t3/src/resourceTelemetry/ResourceMonitorBinary.ts";
import * as ProcessGroupMetrics from "t3/src/resourceTelemetry/ProcessGroupMetrics.ts";
import * as ResourceTelemetry from "t3/src/resourceTelemetry/ResourceTelemetry.ts";
import * as AntigravityUsage from "t3/src/provider/Drivers/AntigravityUsage.ts";
import * as UsageService from "t3/src/usage/UsageService.ts";
import * as CodexUsageHistory from "t3/src/usage/CodexUsageHistory.ts";
import * as RuntimeLayer from "t3/src/orchestration-v2/runtimeLayer.ts";
import * as ProjectStore from "t3/src/orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "t3/src/orchestration-v2/ThreadSearch.ts";
import * as ThreadSettlementService from "t3/src/orchestration-v2/ThreadSettlementService.ts";
import * as ThreadPullRequestService from "t3/src/orchestration-v2/ThreadPullRequestService.ts";
import * as RunFinalizationService from "t3/src/orchestration-v2/RunFinalizationService.ts";
import * as ProjectionMaintenance from "t3/src/orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStoreV2 from "t3/src/orchestration-v2/ProjectionStore.ts";
import * as OrchestrationHttp from "t3/src/orchestration-v2/http.ts";
import * as ProjectHttp from "t3/src/project/http.ts";
import * as ServerActivation from "t3/src/serverActivation.ts";
import { runMigrations } from "t3/src/persistence/Migrations.ts";

import * as DoHttpServer from "../platform/httpServer.ts";
import * as DoServices from "../platform/services.ts";
import * as WorkspaceLayers from "../workspace/layers.ts";
import * as WorkspaceCheckpoints from "../workspace/checkpoints.ts";
import * as DoSql from "../platform/sql.ts";
import * as SecretStore from "../platform/secretStore.ts";
import * as RedactingConsole from "../host/redactingConsole.ts";
import { cloudCapabilities } from "./capabilities.ts";
import { layerManagedPolicy } from "./managedPolicy.ts";
import * as ConnectService from "../connect/service.ts";
import { makePublishRecorder } from "../connect/recorder.ts";
import {
  layerPinAgentBrowserAccessOff,
  layerPinFastWorktreeCheckoutOff,
  layerSeedLinkedEnvironmentsOn,
  layerSeedTextGenerationModel,
} from "../agents/seedSettings.ts";
import { WORKTREES_ROOT } from "@t3flare/workspace-client";

export interface CompositionOptions {
  readonly storage: DurableObjectStorage;
  /**
   * t3's bootstrap token for the first pairing, from a Worker secret (ADR-0010). Set only while an admin
   * route has armed pairing; otherwise t3 seeds no bootstrap grant.
   */
  readonly bootstrapToken: string | undefined;
  /**
   * The public host the Environment is reached on. Setting it makes t3's auth policy `remote-reachable`
   * (a host that is not loopback); without it t3 assumes `loopback-browser`.
   */
  readonly host: string;
  /** Step 3+: the publish-only T3 Connect link's policy (ADR-0025). */
  readonly connect: ConnectService.ConnectPolicy;
}

/** Where the publish recorder keeps its last events (step 3+). */
const PUBLISHES_KEY = "t3flare:connect-publishes";

/** The State directory's root in DO SQLite (ADR-0007). */
export const BASE_DIR = "/t3";

// Escaped MCP handoff provenance can exceed find-my-way's 100-character segment default.
const HTTP_ROUTER_CONFIG = { maxParamLength: 512 } as const;

export const make = (options: CompositionOptions) => {
  const httpServer = DoHttpServer.make();
  // t3flare: the outcome of each T3 Connect publish, read from t3's own log events (step 3+, plan section 4.4).
  const publishRecorder = makePublishRecorder({
    read: () => options.storage.kv.get(PUBLISHES_KEY),
    write: (entries) => options.storage.kv.put(PUBLISHES_KEY, entries),
  });

  // t3flare: the Node platform (NodeServices, NodeCrypto) becomes the DO's.
  const layerPlatformServices = DocumentText.layer.pipe(Layer.provideMerge(DoServices.layer));

  // t3flare: ServerConfig is built here, not from CLI flags. The State directory lives
  // under BASE_DIR in DO SQLite; the bootstrap token comes from the Worker secret.
  const layerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const derived = yield* ServerConfig.deriveServerPaths(BASE_DIR, undefined);
      yield* ServerConfig.ensureServerDirectories(derived);
      // t3's file secret store creates this; ours keeps secrets in DO KV, but replay
      // markers still live here.
      yield* (yield* FileSystem.FileSystem).makeDirectory(derived.secretsDir, { recursive: true });
      // The home directory t3 offers when browsing for a project folder (HostProcess.HomeDirectory).
      yield* (yield* FileSystem.FileSystem).makeDirectory(`${BASE_DIR}/home`, { recursive: true });
      return ServerConfig.ServerConfig.of({
        logLevel: "Info",
        traceMinLevel: "Info",
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 1024 * 1024,
        traceMaxFiles: 1,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpLogsUrl: undefined,
        otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
        otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
        otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
        otelEnvironment: OtelEnvironment.none,
        cwd: BASE_DIR,
        baseDir: BASE_DIR,
        ...derived,
        // t3flare: worktrees are Workspaces at /w/.wt/<project dir>/<dir> (step 2b, ADR-0008).
        worktreesDir: WORKTREES_ROOT,
        mode: "web",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        port: 443,
        // t3flare: the Worker's public host, so t3's auth descriptor reports `remote-reachable`.
        host: options.host,
        desktopBootstrapToken: options.bootstrapToken,
        desktopTelemetryFd: undefined,
        desktopTelemetryControlFd: undefined,
        desktopBrowserFd: undefined,
        desktopBrowserControlFd: undefined,
        resourceMonitorPath: undefined,
        staticDir: undefined,
        devUrl: undefined,
        devAllowedOrigins: [],
        noBrowser: true,
        startupPresentation: "browser",
      });
    }),
  ).pipe(Layer.provide(layerPlatformServices));

  // t3flare: SQL is DO SQLite (ADR-0006). t3's Sqlite.layerSetup sets PRAGMAs DO SQLite
  // refuses (journal_mode, synchronous, …), so only its migrations run here.
  const layerPersistence = Layer.effectDiscard(
    runMigrations().pipe(Effect.withSpan("t3flare.migrations")),
  ).pipe(Layer.provideMerge(DoSql.layer(options.storage)));

  const layerSecretStore = SecretStore.layer(options.storage).pipe(Layer.provide(layerPlatformServices));

  const layerResourceAttribution = ResourceAttribution.layer;
  // t3flare: no event-loop monitor (perf_hooks.monitorEventLoopDelay is not in workerd);
  // EventLoopMonitor is a Reference whose default reports no stalls.
  const layerApplicationObservability = Observability.layer.pipe(
    Layer.provideMerge(layerResourceAttribution),
  );

  // t3flare: no provider event log files; providers run elsewhere (step 2a).
  const layerProviderEventLoggers = Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  );

  const layerServerSettings = ServerSettings.layer.pipe(
    Layer.provide(layerSecretStore),
    // t3flare: t3flare's built-in managed policy, not a file on the host (ADR-0023).
    Layer.provideMerge(layerManagedPolicy),
    Layer.provideMerge(layerPersistence),
  );

  const layerNativeTelemetry = NativeTelemetryClient.layer.pipe(Layer.provide(ResourceMonitorBinary.layer));
  const layerDesktopTelemetryReceiver = DesktopTelemetryReceiver.layer.pipe(
    Layer.provideMerge(layerServerSettings),
  );
  const layerResourceTelemetry = ResourceTelemetry.layer.pipe(
    Layer.provideMerge(layerNativeTelemetry),
    Layer.provideMerge(layerDesktopTelemetryReceiver),
  );
  const layerHostPowerMonitor = HostPowerMonitor.layer.pipe(Layer.provide(layerDesktopTelemetryReceiver));
  const layerDesktopAppUpdate = DesktopAppUpdate.layer.pipe(Layer.provide(layerDesktopTelemetryReceiver));
  const layerBackground = BackgroundPolicy.layer.pipe(
    Layer.provide(layerHostPowerMonitor),
    Layer.provideMerge(layerServerSettings),
  );

  const layerUsage = UsageService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        AntigravityUsage.layer,
        MuseUsageHome.layer,
        CodexUsageHistory.layer,
        CursorUsageAccounts.layer.pipe(Layer.provide(CursorAccountReader.layer)),
      ).pipe(Layer.provide(ProviderHostLive.layer.pipe(Layer.provide(layerSecretStore)))),
    ),
    Layer.provide(layerServerSettings),
  );

  const layerResourceDiagnostics = Layer.mergeAll(
    HostResources.layer,
    layerResourceTelemetry,
    ProcessDiagnostics.layer.pipe(Layer.provide(layerResourceTelemetry)),
    ProcessResourceMonitor.layer.pipe(Layer.provide(layerResourceTelemetry)),
    ProcessGroupMetrics.layer.pipe(Layer.provide(layerResourceTelemetry)),
  );

  // t3flare: no T3 Connect tunnel (ADR-0010, ADR-0011); cloudflared is never installed.
  const layerRelayClient = RelayClient.layerCloudflared({ baseDir: BASE_DIR });

  // t3flare: checkpoints of a Workspace's repo are its Durable Object's (isomorphic-git), not a Container per turn.
  const layerVcsDriverRegistry = WorkspaceCheckpoints.layerVcsDriverRegistry(
    VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
  );
  const layerSourceControlProviderRegistry = SourceControlProviderRegistry.layer.pipe(
    Layer.provideMerge(SourceControlBuiltInDrivers.layer),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(layerVcsDriverRegistry),
  );

  const layerRepositoryIdentityResolver = Layer.effect(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
    Effect.gen(function* () {
      const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
      return yield* RepositoryIdentityResolver.make({
        refine: Effect.fn(function* (identity: RepositoryIdentity) {
          for (const { kind } of BUILT_IN_SOURCE_CONTROL_DRIVER_LIST) {
            const provider = yield* registry.get(kind);
            if (provider.refineRepositoryIdentity === undefined) continue;
            const refined = yield* provider.refineRepositoryIdentity({
              identity,
              resolveContext: (input) =>
                registry.resolveHandle(input).pipe(Effect.map((handle) => handle.context)),
            });
            if (refined !== identity) return refined;
          }
          return identity;
        }),
      });
    }),
  ).pipe(Layer.provide(layerSourceControlProviderRegistry), Layer.provide(ProcessRunner.layer));

  const layerPullRequestService = PullRequestService.layer.pipe(
    Layer.provide(PullRequestProviderRegistry.layer),
    Layer.provide(PullRequestFilesViewed.layer),
    Layer.provide(PullRequestReadCache.layer),
    Layer.provide(layerSourceControlProviderRegistry),
    Layer.provide(SourceControlRateLimit.layer),
  );

  const layerGitManager = GitManager.layer.pipe(
    Layer.provide(Layer.merge(ProjectionStoreV2.layer, ProjectStore.layer)),
    Layer.provideMerge(RuntimeLayer.layerProjectSetupScriptRunner),
    Layer.provideMerge(WorktreeSetupTracker.layer),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(layerSourceControlProviderRegistry),
    Layer.provideMerge(TextGeneration.layer.pipe(Layer.provide(layerSourceControlProviderRegistry))),
  );
  const layerGit = Layer.empty.pipe(Layer.provideMerge(layerGitManager), Layer.provideMerge(GitVcsDriver.layer));
  const layerGitWorkflow = GitWorkflowService.layer.pipe(
    Layer.provideMerge(layerVcsDriverRegistry),
    Layer.provideMerge(layerGit),
  );
  const layerSourceControlRepositoryService = SourceControlRepositoryService.layer.pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(layerSourceControlProviderRegistry),
  );
  const layerProjectCloneTracker = ProjectCloneTracker.layer.pipe(Layer.provide(layerSourceControlRepositoryService));
  const layerKnownWorkspaces = KnownWorkspaces.layer.pipe(
    Layer.provide(ProjectStore.layer),
    Layer.provide(GitVcsDriver.layer),
  );
  const layerReview = ReviewService.layer.pipe(
    Layer.provideMerge(layerKnownWorkspaces),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(layerVcsDriverRegistry),
  );
  const layerVcs = Layer.empty.pipe(
    Layer.provideMerge(VcsProjectConfig.layer),
    Layer.provideMerge(layerVcsDriverRegistry),
    Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(layerVcsDriverRegistry))),
    Layer.provideMerge(layerGitWorkflow),
    Layer.provideMerge(layerReview),
    Layer.provideMerge(layerSourceControlRepositoryService),
    Layer.provideMerge(SourceControlSignIn.layer.pipe(Layer.provide(layerSourceControlProviderRegistry))),
    Layer.provideMerge(layerProjectCloneTracker),
    Layer.provideMerge(
      VcsStatusBroadcaster.layer.pipe(
        Layer.provide(layerGitWorkflow),
        // t3flare: no automatic fetches: each would start the Workspace's Container (step 2a plan, section 2).
        Layer.provide(Layer.succeed(VcsStatusBroadcaster.VcsAutomaticFetchInterval, Effect.succeed(Duration.zero))),
        Layer.provide(VcsStatusBroadcaster.layerAutoPullPolicy.pipe(Layer.provide(ProjectStore.layer))),
      ),
    ),
  );

  const layerCheckpointStore = CheckpointStore.layer.pipe(Layer.provide(layerVcsDriverRegistry));
  const layerPortScanner = PortScanner.layer.pipe(Layer.provide(ProcessRunner.layer));
  // t3flare: t3's TerminalManager over our PTY adapter: shells in the Workspace's Container (step 2b, ADR-0021).
  const layerTerminal = TerminalLayer.layer;
  const layerPreview = Layer.empty.pipe(Layer.provideMerge(PreviewManager.layer), Layer.provideMerge(layerPortScanner));
  const layerDevice = DeviceService.layer.pipe(
    Layer.provide(layerServerSettings),
    Layer.provide(ProcessRunner.layer),
    Layer.provide(NetService.layer),
  );

  // t3flare: paths in a Workspace (`/w/…`) are its Durable Object's files, over RPC; the stock services keep the rest.
  const layerWorkspaceEntries = WorkspaceLayers.layerWorkspaceEntries(
    WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer)),
  );
  const layerWorkspaceFileSystem = WorkspaceLayers.layerWorkspaceFileSystem(
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(layerWorkspaceEntries),
      Layer.provide(layerKnownWorkspaces),
    ),
  );
  const layerWorkspace = Layer.mergeAll(WorkspacePaths.layer, layerWorkspaceEntries, layerWorkspaceFileSystem);
  const layerProjectFaviconResolver = ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  );

  // t3flare: the capabilities of what the Cloud Environment does (`./capabilities.ts`) and `platform.machine: "cloud"`.
  const layerServerEnvironment = Layer.effect(
    ServerEnvironment.ServerEnvironment,
    Effect.map(ServerEnvironment.make, (environment) =>
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: environment.getEnvironmentId,
        getDescriptor: Effect.map(environment.getDescriptor, (descriptor) => ({
          ...descriptor,
          label: "t3flare",
          platform: { ...descriptor.platform, os: "linux" as const, machine: "cloud" as const },
          capabilities: cloudCapabilities(descriptor.capabilities),
        })),
      }),
    ),
  ).pipe(
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provide(ProcessRunner.layer),
    Layer.provide(layerSecretStore),
  );

  const layerAuth = EnvironmentAuth.layer.pipe(
    Layer.provideMerge(layerPersistence),
    Layer.provide(layerServerEnvironment),
    Layer.provide(layerSecretStore),
  );

  const layerCloudManagedEndpointRuntime = Layer.mergeAll(
    layerRelayClient,
    CloudManagedEndpointRuntime.layer.pipe(Layer.provide(layerSecretStore), Layer.provide(layerRelayClient)),
  );

  // t3flare: no relay, so scheduled-task webhooks have no public hook URL.
  const layerScheduledTaskWebhookOrigin = Layer.succeed(
    ScheduledTaskWebhookOrigin,
    Effect.succeed({ relayHookBaseUrl: null }),
  );

  const layerOrchestrationV2Runtime = RuntimeLayer.layerProduction.pipe(
    Layer.provide(layerScheduledTaskWebhookOrigin),
    Layer.provide(ProviderUsageAnalytics.layer),
    Layer.provide(layerCheckpointStore),
    Layer.provide(layerGitWorkflow),
    Layer.provide(
      RunFinalizationService.layerObserver.pipe(
        Layer.provide(ProjectionStoreV2.layer),
        Layer.provide(layerPullRequestService),
        Layer.provide(RuntimeLayer.layerProjectService),
      ),
    ),
  );

  const layerOrchestrationApplication = Layer.merge(CheckpointDiffQuery.layer, NativeChildWorkQuery.layer).pipe(
    Layer.provideMerge(layerCheckpointStore),
    Layer.provideMerge(layerOrchestrationV2Runtime),
  );

  const layerThreadSettlementWorker = Layer.effectDiscard(
    ThreadSettlementService.make.pipe(Effect.flatMap((service) => service.start())),
  ).pipe(Layer.provide(layerPullRequestService), Layer.provide(ProjectionStoreV2.layer));
  // t3flare (step 4b, review F7): t3's idle compaction is not started. It sends `/compact` as a turn to `claudeAgent`
  // instances only, which here are Claude Code in a Workspace's Container: it would start a Container for a
  // compaction nobody asked for. Its setting is locked off by the managed policy (`managedPolicy.ts`).
  const layerThreadPullRequestWorker = Layer.effectDiscard(
    ThreadPullRequestService.make.pipe(Effect.flatMap((service) => service.start())),
  ).pipe(Layer.provide(layerPullRequestService));

  const layerProviderInstallationRefresh = Layer.effectDiscard(
    Effect.gen(function* () {
      const antigravity = yield* AntigravityInstallation.AntigravityInstallation;
      const codex = yield* CodexInstallation.CodexInstallation;
      const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
      const providers = yield* ProviderRegistry.ProviderRegistry;
      yield* Stream.merge(
        antigravity.changes.pipe(
          Stream.changesWith((a, b) => a.installedVersion === b.installedVersion),
          Stream.drop(1),
        ),
        codex.changes.pipe(
          Stream.changesWith((a, b) => a.installedVersion === b.installedVersion),
          Stream.drop(1),
        ),
      ).pipe(
        Stream.runForEach((state) =>
          instances.listInstances.pipe(
            Effect.flatMap((entries) =>
              Effect.forEach(
                entries.filter((instance) => instance.driverKind === state.driver),
                (instance) => providers.refreshInstance(instance.instanceId),
                { discard: true },
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );

  // t3flare: nothing restarts the DO on request; a restart is an eviction.
  const layerServerRestart = Layer.succeed(DatabaseStorage.ServerRestart, null);

  const layerRuntimeCoreDependenciesBase = Layer.mergeAll(
    AgentAwarenessRelay.layer,
    HeldHooksWaker.layer,
    layerThreadSettlementWorker,
    StorageCleanup.layer.pipe(Layer.provide(ProjectionStoreV2.layer)),
    DatabaseStorage.layer.pipe(Layer.provide(ProjectionMaintenance.layer), Layer.provide(layerServerRestart)),
    layerThreadPullRequestWorker,
    DelegatedTaskAnalytics.layer,
    Layer.effectDiscard(
      Effect.gen(function* () {
        const service = yield* PullRequestSyncReactor.PullRequestSyncReactor;
        yield* service.start();
      }),
    ).pipe(
      Layer.provideMerge(PullRequestSyncReactor.layer),
      Layer.provide(layerPullRequestService),
      Layer.provide(ProjectionStoreV2.layer),
    ),
    Layer.effectDiscard(
      Effect.gen(function* () {
        const service = yield* PullRequestWatchReactor.PullRequestWatchReactor;
        yield* service.start();
      }),
    ).pipe(
      Layer.provide(PullRequestWatchReactor.layer),
      Layer.provide(layerPullRequestService),
      Layer.provide(ProjectionStoreV2.layer),
    ),
    Layer.effectDiscard(
      Effect.gen(function* () {
        const service = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
        yield* service.start();
      }),
    ).pipe(Layer.provide(DelegatedTaskQuestionReactor.layer), Layer.provide(ProjectionStoreV2.layer)),
    ProviderUsageLimitsIngestion.layer,
    layerProviderInstallationRefresh,
    ProviderInstallation.layer,
    ReplayMarkers.layer,
    Layer.effectDiscard(ProjectSettingsOverrideSweep.sweep),
    // t3flare: text generation's model points at the Durable agent provider (step 2a, R12).
    layerSeedTextGenerationModel,
    // t3flare: every worktree is a Workspace of its own (step 2b): no fast checkout cache.
    layerPinFastWorktreeCheckoutOff,
    // t3flare: the laptop links to the cloud (step 3, L1, once), and the cloud has no browser (L3).
    layerSeedLinkedEnvironmentsOn,
    layerPinAgentBrowserAccessOff,
  ).pipe(
    Layer.provideMerge(layerOrchestrationApplication),
    Layer.provideMerge(RuntimeLayer.layerEventInfrastructure),
    Layer.provideMerge(Layer.merge(ProjectStore.layer, ThreadSearch.layer)),
    Layer.provideMerge(SecretResolver.layer),
    Layer.provideMerge(layerServerSettings),
    Layer.provideMerge(layerSourceControlProviderRegistry),
    Layer.provideMerge(layerGit),
    Layer.provideMerge(layerVcs),
    Layer.provideMerge(Layer.mergeAll(layerTerminal, layerPreview, layerDevice)),
    Layer.provideMerge(layerPersistence),
    Layer.provideMerge(Layer.mergeAll(Keybindings.layer, EnvironmentTheme.layer, UsageLimitSources.layer)),
    Layer.provideMerge(ProviderRegistry.layer),
    Layer.provideMerge(ProviderInstanceRegistryHydration.layer),
    Layer.provideMerge(layerPortScanner),
    Layer.provideMerge(
      Layer.mergeAll(AntigravityInstallation.AntigravityInstallation.layer, CodexInstallation.CodexInstallation.layer),
    ),
  );

  const layerRuntimeCoreDependencies = layerRuntimeCoreDependenciesBase.pipe(
    Layer.provideMerge(DoServices.layerPty),
    Layer.provideMerge(AcpRegistrySupport.layerFromHost.pipe(Layer.provide(ProviderHostLive.layer))),
    Layer.provideMerge(
      Layer.mergeAll(
        layerProviderEventLoggers,
        ModelManifest.layerModelCatalog.pipe(Layer.provideMerge(ModelManifest.layer)),
        ResetCreditCoordinator.layer,
        ProviderLatestVersions.layer,
        McpProviderSessions.layer,
      ),
    ),
    Layer.provideMerge(
      OpenCodeRuntime.layer.pipe(
        Layer.provide(
          Layer.unwrap(
            Effect.gen(function* () {
              const config = yield* ServerConfig.ServerConfig;
              return OpenCodeServerLedger.layer({ stateDir: config.stateDir });
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(layerWorkspace),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(Layer.mergeAll(NativeAppIconResolver.layer, layerProjectFaviconResolver)),
    Layer.provideMerge(layerRepositoryIdentityResolver),
    Layer.provideMerge(CodexManagedTokenBroker.layer),
    Layer.provideMerge(layerServerEnvironment),
    Layer.provideMerge(layerAuth),
    Layer.provideMerge(Layer.mergeAll(AssetSigner.layer, EnvironmentKeys.layer)),
    Layer.provideMerge(layerSecretStore),
    Layer.provideMerge(
      Layer.mergeAll(
        CloudCliTokenManager.layer.pipe(Layer.provide(layerSecretStore), Layer.provide(ExternalLauncher.layer)),
        layerCloudManagedEndpointRuntime,
      ),
    ),
  );

  const layerRuntimeDependencies = layerRuntimeCoreDependencies.pipe(
    Layer.provideMerge(layerUsage),
    Layer.provideMerge(layerBackground),
    Layer.provideMerge(layerResourceDiagnostics),
    Layer.provideMerge(TraceDiagnostics.layer),
    Layer.provideMerge(TriageService.layer.pipe(Layer.provide(GitVcsDriver.layer))),
    Layer.provideMerge(AnalyticsService.layer.pipe(Layer.provide(layerManagedPolicy))),
    Layer.provideMerge(ExternalLauncher.layer),
    Layer.provideMerge(RemoteOpenTargets.layer),
    Layer.provideMerge(DirectEndpoints.layer),
    Layer.provideMerge(ServerLifecycleEvents.layer),
    Layer.provide(NetService.layer),
  );

  const layerCommandReadiness = HttpRouter.middleware(
    (httpEffect) =>
      Effect.flatMap(ServerRuntimeStartup.ServerRuntimeStartup, (startup) =>
        startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect)),
      ),
    { global: true },
  );

  // t3flare: only the routes a paired client needs (ADR-0010): no guest links, OTLP proxy,
  // device hub, server browser stream, speech stream or static files (assets serve the
  // web client). The HttpApi groups stay whole, because HttpApiBuilder needs every group.
  const layerMakeRoutes = Layer.mergeAll(
    Layer.mergeAll(
      HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
        Layer.provide(AuthHttp.layer),
        Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
        Layer.provide(CloudHttp.layer),
        Layer.provide(OrchestrationHttp.layer),
        Layer.provide(PullRequestHttp.layer),
        Layer.provide(ProjectHttp.layer),
        Layer.provide(speechHttpApiLayer),
        Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
        Layer.provide(WebhookRoute.layer.pipe(Layer.provide(RelayDeliveryProof.layer))),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
      ),
      ServerHttp.layerAssetRoute,
      ServerHttp.layerAttachmentUploadRoute,
      Ws.layer,
    ),
    McpHttpServer.layer.pipe(
      Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
      Layer.provide(McpOAuth.layerMcpClientAuthenticator),
    ),
    Layer.effectDiscard(RemoteDelegation.RemoteDelegation.pipe(Effect.flatMap((remote) => remote.start()))),
  ).pipe(
    Layer.provide(PullRequestReviewGuideService.layer.pipe(Layer.provide(PullRequestReviewGuides.layer))),
    Layer.provide(RemoteDelegation.layer.pipe(Layer.provide(ProjectionStoreV2.layer))),
    Layer.provide(PeerLinkRequests.layer),
    Layer.provide(layerPullRequestService),
    Layer.provide(
      ServerBrowser.layer.pipe(Layer.provide(Layer.merge(DesktopBrowserChannel.layer, PreviewAgentActivity.layer))),
    ),
    Layer.provide(PreviewBrowser.layer),
    Layer.provide(PeerForwarding.layer.pipe(Layer.provideMerge(PeerMcpClient.layer), Layer.provideMerge(PeerLinks.layer))),
    Layer.provide(SpeechService.layer.pipe(Layer.provide(layerServerSettings), Layer.provide(SpeechModelStore.layer))),
    Layer.provide(CloudSpeech.layer.pipe(Layer.provide(SecretResolver.layer))),
    Layer.provide(layerServerSettings),
    Layer.provide(PreviewAutomationBroker.layer),
    Layer.provide(ServerSelfUpdate.layer.pipe(Layer.provide(layerDesktopAppUpdate))),
    Layer.provide(layerCommandReadiness),
    Layer.provide(ServerHttp.layerBrowserApiCors),
    // t3flare: no response compression in t3; Cloudflare's edge compresses, and workerd
    // would compress a body t3 already gzipped a second time.
  );

  const layerMakeServer = Layer.unwrap(
    Effect.gen(function* () {
      // t3flare: no server ownership lock, PATH fixing, runtime-state file, Tailscale
      // Serve, and no T3 Connect link at startup: one DO is the only server, and it has no host. The
      // publish-only link is made once, from an admin route (step 3+, ADR-0025).
      const activation = yield* Deferred.make<void>();
      const layerActivation = Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation));
      const routesReady = yield* Deferred.make<void>();
      const layerLauncher = ServiceLauncherClient.layer;

      const layerHttpListening = Layer.effectDiscard(
        Effect.gen(function* () {
          yield* HttpServer.HttpServer;
          const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
          yield* startup.markHttpListening;
        }),
      );

      const layerRuntimeServices = ServerRuntimeStartup.layerWithOptions({
        activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
        abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
        awaitAuxiliaryParked: Deferred.await(routesReady),
      }).pipe(Layer.provideMerge(layerRuntimeDependencies), Layer.provide(layerLauncher));

      const layerRoutes = HttpRouter.serve(layerMakeRoutes.pipe(Layer.provide(layerLauncher)), {
        disableLogger: true,
        disableListenLog: true,
        routerConfig: HTTP_ROUTER_CONFIG,
      }).pipe(
        ServerHttp.withUntracedRequests,
        Layer.tap(() => Deferred.succeed(routesReady, undefined).pipe(Effect.orDie)),
      );

      // t3flare: one CloudLink (step 3+, review finding 1). The Connect service, which links outward from the admin
      // routes, gets it whole; t3's HTTP routes get it with the four relay-initiated calls refused.
      const layerCloudLink = CloudLink.layer.pipe(Layer.provideMerge(ConnectReachability.layer));
      const layerConnect = ConnectService.layer(options.connect, publishRecorder).pipe(Layer.provide(layerCloudLink));
      const layerRouteCloudLink = Layer.merge(
        ConnectService.layerRefusingCloudLink.pipe(Layer.provide(layerCloudLink)),
        ConnectReachability.layer,
      );

      return Layer.mergeAll(layerRoutes, layerHttpListening, layerConnect).pipe(
        Layer.provide(layerRouteCloudLink),
        Layer.provideMerge(layerRuntimeServices),
        Layer.provideMerge(McpSessionRegistry.layer.pipe(Layer.provide(layerServerEnvironment))),
        Layer.provide(layerActivation),
        Layer.provideMerge(RelayTracing.layerServerRelayBroker.pipe(Layer.provide(layerManagedPolicy))),
        Layer.provideMerge(DoHttpServer.layer(httpServer)),
        // t3flare: t3's loggers, and the publish recorder beside them (step 3+).
        Layer.provide(
          Logger.layer([publishRecorder.logger], { mergeWithExisting: true }).pipe(Layer.provideMerge(layerApplicationObservability)),
        ),
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(VcsProcess.layer),
        Layer.provideMerge(AgentScopeLive.layer),
        Layer.provideMerge(layerPlatformServices),
      );
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));

  // t3flare: t3's Console (and the loggers writing through it) drops the boot pairing URL and redacts
  // credentials, so no token reaches Workers Logs (ADR-0010).
  const layer = layerMakeServer.pipe(
    Layer.provide(layerConfig),
    Layer.provide(layerPlatformServices),
    Layer.provide(RedactingConsole.layer),
  );

  return { layer, http: httpServer.http };
};

