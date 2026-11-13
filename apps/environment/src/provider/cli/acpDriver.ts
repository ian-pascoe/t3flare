// @effect-diagnostics globalConsole:off globalConsoleInEffect:off globalJsonInEffect:off effectFnOpportunity:off
// Claude Code and OpenCode in the Cloud Environment (step 4b, plan §3 with the review's F1, F2, F4, F7, F9): t3's own
// kinds (`claudeAgent` "Claude", `opencode` "OpenCode"), so the stock clients' names and icons apply, each built on
// t3's generic ACP adapter (`makeAcpAdapterV2`) with a flavor of ours, running `claude-agent-acp` or `opencode acp` in
// the Workspace's Container through 4a's process channel. Readiness is the image's version and the proxy's catalog,
// never a spawning probe; t3's MCP credential is withheld (OD-3); text generation is the proxy's; 4a's wrapper runs
// around the adapter (one process per session, the hold, the 2 h cap).
import { type ChatAttachment, type ProviderDriverKind, type ProviderInstanceId, type ServerProvider, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { Catalog } from "@t3flare/models/catalog";
import { defaultProviderContinuationIdentity, type ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { buildServerProvider, type ServerProviderPresentation } from "@t3tools/provider-core/server/snapshotProbe";
import { haveProviderSnapshotSettingsChanged, makeProviderSnapshotSettingsSource } from "@t3tools/provider-core/server/snapshotSettings";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2, type AcpAdapterV2Flavor, type AcpAdapterV2Options, type AcpAdapterV2RuntimeInput } from "@t3tools/provider-acp/server/adapter";
import { ACP_SESSION_MODE_OPTION_ID } from "@t3tools/provider-acp/server/sessionConfig";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  extractClaudeSubagentSessionEvent,
  extractClaudeSubagentUpdate,
  isClaudeProvisionalSubagentTool,
} from "../../../../../t3code/packages/provider-acp-registry/src/server/claudeAcp.ts";
import { environmentServices } from "../../agents/bindings.ts";
import { attachmentReader, turnPrompt } from "../attachments.ts";
import { snapshotModels } from "../models.ts";
import type { CliAgent } from "@t3flare/skills";
import { cliSnapshotForCwdOf, environmentSkillsAccess, messageSkillsFor, type SkillsAccess } from "../skills.ts";
import { claudeMentionRewrite } from "./claudeSkills.ts";
import { CLI_BUILT_IN_COMMANDS } from "./builtInCommands.ts";
import { makePiDurableTextGeneration } from "../textGeneration.ts";
import {
  type AcpCli,
  cliModelId,
  cliPermissionDisposition,
  cliPromptFailure,
  cliRuntimeModeForSessionMode,
  cliSessionModeForPolicy,
  guardedRuntime,
  guardSlots,
  PINNED_MODE,
} from "./acpFlavor.ts";
import { t3McpForCli } from "./relayedMcp.ts";
import { CliSpawn, CliTurn, type CliSessions, wrapCliAdapter } from "./wrapper.ts";
import { relayUrl } from "../../agents/cliProfiles.ts";

export type AcpCliDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderContinuationRequests.ProviderContinuationRequests
  | ProviderHost.ProviderHost
  | SecureRandom.SecureRandom;

/** The effort levels both agents offer as their `effort` config option (M0 P1, P2). */
const EFFORTS = [
  { id: "default", label: "Default", isDefault: true },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
] as const;

/** The catalog's models, with the agents' `effort` picker for reasoning models (t3's adapter sets it by id). */
export const acpSnapshotModels = (catalog: Catalog): ReadonlyArray<ServerProviderModel> => {
  const reasoning = new Set(catalog.models.filter((model) => model.reasoning).map((model) => model.slug));
  return snapshotModels(catalog).map((model) => ({
    ...model,
    capabilities: createModelCapabilities({
      optionDescriptors: reasoning.has(model.slug) ? [{ id: "effort", label: "Effort", type: "select", options: EFFORTS.map((effort) => ({ ...effort })) }] : [],
    }),
  }));
};

/**
 * The capabilities t3 reads (plan §1.4): t3's ACP set, rollback on (SPI-1037, once SPI-1100 made the checkpoints hold
 * what the CLI wrote; the wrapper spawns the replacement agent as the session's), Claude's proposed plan recovered (F1).
 */
export const acpCapabilities = (cli: AcpCli) => ({
  ...AcpProviderCapabilitiesV2,
  planning: { ...AcpProviderCapabilitiesV2.planning, emitsProposedPlan: cli === "claude" },
});

/** Never used: only t3's MCP bridge reads it, and t3's MCP is withheld (OD-3). */
const SELF_INVOCATION = { command: "t3flare-no-self-invocation", entrypoint: undefined } as const;

const LIFECYCLE: ReadonlySet<string> = new Set(["initialize", "session/new", "session/load", "session/resume", "session/fork", "session/close"]);

/** The runtime each session runs: the CLI through t3's spawner (the process channel). */
const spawnRuntime = (cli: AcpCli) => (input: AcpAdapterV2RuntimeInput) =>
  Effect.gen(function* () {
    // t3's environment and policy are not passed on: the profile decides the environment (4a §4.6) and the flavor applies
    // the policy. Of t3's MCP servers only its own (`t3-code`, with t3's per-thread bearer at t3's public `/mcp`, as stock
    // t3 hands it: owner, 2026-11-12, back to stock) is kept.
    const { processEnvironment, runtimePolicy: _policy, mcpServers: _mcp, acpMcpServers: _acp, httpMcpServers: _http, ...options } = input;
    // t3's adapter offers its server as a stdio bridge (not in a Container) or, per flavor, over HTTP; here it is always
    // the HTTP entry, from the session config t3 put in the process environment (the endpoint relayedMcp.ts rewrote).
    const t3Endpoint = processEnvironment?.T3_ACP_MCP_ENDPOINT;
    const t3Authorization = processEnvironment?.T3_ACP_MCP_AUTHORIZATION;
    const t3Own: ReadonlyArray<EffectAcpSchema.McpServer> =
      typeof t3Endpoint === "string" && typeof t3Authorization === "string"
        ? [{ type: "http", name: "t3-code", url: t3Endpoint, headers: [{ name: "Authorization", value: t3Authorization }] } as EffectAcpSchema.McpServer]
        : [];
    // ADR-0028: the MCP relay's third-party servers, with this session's process's tool handle (per process, review H2),
    // on every session/new, load, resume and fork.
    const session = yield* CliSpawn;
    const relayServers: ReadonlyArray<EffectAcpSchema.McpServer> = [
      ...(session === undefined
        ? []
        : environmentServices()
            .relayServers()
            .map((name) => ({ type: "http" as const, name, url: relayUrl(name), headers: [{ name: "Authorization", value: `Bearer ${session.toolHandle}` }] }) as EffectAcpSchema.McpServer)),
      ...t3Own,
    ];
    const relayActivation = { mcpServers: relayServers, acpMcpServers: [], httpMcpServers: relayServers };
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...options,
        ...relayActivation,
        // The session lifecycle in the log (method and outcome, never a payload): review F8's resume proof is a
        // `session/load` or `session/resume` that succeeded.
        requestLogger: (event) =>
          Effect.andThen(
            LIFECYCLE.has(event.method) && event.status !== "started"
              ? Effect.sync(() => console.log(JSON.stringify({ t3flare: "acp-request", cli, method: event.method, status: event.status })))
              : Effect.void,
            options.requestLogger?.(event) ?? Effect.void,
          ),
        spawn: cli === "claude" ? { command: "claude-agent-acp", args: [], cwd: input.cwd, env: {}, extendEnv: false, shell: false } : { command: "opencode", args: ["acp"], cwd: input.cwd, env: {}, extendEnv: false, shell: false },
        ownDetachedProcessGroup: true,
        ownDescendantProcessGroups: false,
        linuxCgroupController: null,
        processGroupPlatform: "linux",
        // A sign-in is never offered (ADR-0016): an auth_required is the proxy key's failure (cliPromptFailure).
        authenticateOnAuthRequired: false,
      }),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
    if (relayServers.length === 0) return runtime;
    return {
      ...runtime,
      loadSession: (sessionId, activation) => runtime.loadSession(sessionId, { ...activation, ...relayActivation }),
      resumeSession: (sessionId, activation) => runtime.resumeSession(sessionId, { ...activation, ...relayActivation }),
      forkSession: (sessionId, activation, meta) => runtime.forkSession(sessionId, { ...activation, ...relayActivation }, meta),
    } satisfies typeof runtime;
  });

export interface AcpCliDriverSpec {
  readonly cli: AcpCli;
  readonly driver: ProviderDriverKind;
  readonly presentation: ServerProviderPresentation;
  readonly version: string;
}

/** The snapshot's note on what of t3's settings form is ignored here (plan §3.1). */
const IGNORED_SETTINGS: Readonly<Record<AcpCli, string>> = {
  claude: "Runs Claude Code in the Workspace's Container on the model proxy; the binary, home, launch arguments and custom models settings are not used.",
  opencode: "Runs OpenCode in the Workspace's Container on the model proxy; the binary, server URL, password and custom models settings are not used.",
};

const snapshotOf = (spec: AcpCliDriverSpec, enabled: boolean) =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: spec.presentation,
      enabled,
      checkedAt,
      models: acpSnapshotModels(environmentServices().catalog.current()),
      // SPI-1151: the built-ins that run here (none: t3's ACP adapter refuses `/compact` without a compacting flavor).
      slashCommands: CLI_BUILT_IN_COMMANDS[spec.cli],
      probe: { installed: true, version: spec.version, status: "ready", auth: { status: "authenticated" }, message: IGNORED_SETTINGS[spec.cli] },
    });
  });

export interface AcpFlavorOptions {
  readonly buildPrompt?: AcpAdapterV2Flavor["buildPrompt"];
  /** The unguarded runtime (tests replay a recorded agent); by default the CLI through the process channel. */
  readonly spawn?: AcpAdapterV2Flavor["makeRuntime"];
}

/** The flavor: plan §3.2's table, back to t3's own modes (owner, 2026-11-12). Every runtime is wrapped (`guardedRuntime`). */
export const acpFlavor = (cli: AcpCli, driver: ProviderDriverKind, options: AcpFlavorOptions = {}): AcpAdapterV2Flavor => ({
  driver,
  capabilities: acpCapabilities(cli),
  makeRuntime: (input) => (options.spawn ?? spawnRuntime(cli))(input).pipe(Effect.map((runtime) => guardedRuntime(cli, runtime))),
  // The agent is pinned to its asking mode (Claude's auto for t3's auto); t3's plan handling moves it to plan for a plan
  // turn and back (plan §5.1).
  ...(cli === "claude" ? { sessionModeForPolicy: cliSessionModeForPolicy("claude") } : { sessionConfigForPolicy: () => [{ id: "mode", value: PINNED_MODE.opencode }] }),
  runtimeModeForSessionMode: cliRuntimeModeForSessionMode(cli),
  // Native mode choices in a model selection are never applied (plan §3.3): the generic option loop skips owned ids.
  ownedModelOptionIds: ["mode", ACP_SESSION_MODE_OPTION_ID],
  permissionDisposition: cliPermissionDisposition,
  promptFailure: (cause) => cliPromptFailure(cause),
  requiresSignIn: () => false,
  resolveModelId: (selection) => cliModelId(cli, selection.model),
  ...(options.buildPrompt === undefined ? {} : { buildPrompt: options.buildPrompt }),
  // Review F1: the plan is captured when Claude asks to leave plan mode (guardedRuntime), not after the turn settles.
  registerExtensions: ({ runtime, captureProposedPlan }) =>
    Effect.sync(() => {
      const slot = guardSlots.get(runtime);
      if (slot !== undefined) slot.capture = captureProposedPlan;
    }),
  ...(cli === "claude"
    ? {
        // claude-agent-acp's ACP v2 work state and subagents, as t3's registry flavor maps them (reg/claudeAcp.ts).
        followAgentWorkState: true,
        extractSubagentUpdate: extractClaudeSubagentUpdate,
        isProvisionalSubagentTool: isClaudeProvisionalSubagentTool,
        extractSubagentSessionEvent: extractClaudeSubagentSessionEvent,
      }
    : {}),
});

/**
 * Prompts (plan §3.5): SPI-993's rules for Durable agents, images inline when the agent takes them, text files inline.
 * SPI-1151: with `skills` (OpenCode's), a message's Skill mentions embed as OpenCode's skill tool returns them, read for
 * the turn's thread (`CliTurn`: t3's adapter gives the builder no cwd).
 */
export const acpPromptBuilder = (
  host: ProviderHost.ProviderHost["Service"],
  fileSystem: FileSystem.FileSystem,
  skills?: { readonly access: SkillsAccess; readonly agent: CliAgent },
): NonNullable<AcpAdapterV2Flavor["buildPrompt"]> => {
  const reader = attachmentReader(host, fileSystem);
  return (input) =>
    Effect.gen(function* () {
      const turn = yield* CliTurn;
      const threadSkills = skills === undefined || turn === undefined ? undefined : messageSkillsFor(turn.cwd, skills.access, skills.agent);
      return yield* turnPrompt(
        { text: input.text, attachments: input.attachments as ReadonlyArray<ChatAttachment> },
        { acceptsImages: input.promptCapabilities?.image === true, reader, ...(threadSkills === undefined ? {} : { skills: threadSkills }) },
      );
    }).pipe(
      Effect.map(({ text, images }): ReadonlyArray<EffectAcpSchema.ContentBlock> => [
        { type: "text", text },
        ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
      ]),
    );
};

/**
 * The options t3's ACP adapter runs with here. Never `clientTerminals`: with it the adapter would run the agent's
 * terminal commands itself, in t3's process (the Environment DO, which runs no processes), outside the Workspace.
 */
export const acpAdapterOptions = (
  instanceId: ProviderInstanceId,
  flavor: AcpAdapterV2Flavor,
  continuationRequests: AcpAdapterV2Options["continuationRequests"],
): AcpAdapterV2Options => ({ instanceId, flavor, selfInvocation: SELF_INVOCATION, ...(continuationRequests === undefined ? {} : { continuationRequests }) });

/** One instance of an ACP CLI driver (`ProviderDriver.create`'s body). */
export const createAcpCliInstance = Effect.fn("AcpCliDriver.create")(function* <Config extends { readonly enabled: boolean }>(
  spec: AcpCliDriverSpec,
  input: { readonly instanceId: ProviderInstanceId; readonly displayName: string | undefined; readonly accentColor?: string | undefined; readonly enabled: boolean; readonly config: Config },
) {
  const { instanceId, displayName, accentColor, enabled, config } = input;
  const continuationIdentity = defaultProviderContinuationIdentity({ driverKind: spec.driver, instanceId });
  const stamp = (draft: Omit<ServerProvider, "instanceId" | "driver">): ServerProvider => ({
    ...draft,
    instanceId,
    driver: spec.driver,
    ...(displayName ? { displayName } : {}),
    ...(accentColor ? { accentColor } : {}),
    continuation: { groupKey: continuationIdentity.continuationKey },
  });
  const effective = { ...config, enabled };
  const { catalog } = environmentServices();
  const settingsSource = yield* makeProviderSnapshotSettingsSource(effective);
  const maintenance = makeManualOnlyProviderMaintenanceCapabilities({ provider: spec.driver, packageName: null });
  const snapshot = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed(maintenance),
    getSettings: settingsSource.getSettings,
    streamSettings: settingsSource.streamSettings,
    haveSettingsChanged: haveProviderSnapshotSettingsChanged,
    initialSnapshot: (settings) => snapshotOf(spec, settings.provider.enabled).pipe(Effect.map(stamp)),
    checkProvider: Effect.promise(() => catalog.refresh()).pipe(
      Effect.flatMap(() => snapshotOf(spec, effective.enabled)),
      Effect.map(stamp),
    ),
  }).pipe(Effect.orDie);
  yield* Effect.forkScoped(snapshot.refresh);
  const realMcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const sessions: CliSessions = new Map();
  // t3's own tools with t3's per-thread bearer, as stock t3 hands them, at t3's public `/mcp` (owner, 2026-11-12, back
  // to stock; relayedMcp.ts).
  const relayed = t3McpForCli(realMcpSessions, () => environmentServices().t3McpUrl());
  const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  const host = yield* ProviderHost.ProviderHost;
  const fileSystem = yield* FileSystem.FileSystem;
  // SPI-1151: a picked Skill reaches the CLI as its own: Claude Code's mention rewritten (the wrapper), OpenCode's embedded.
  const skillsAccess = environmentSkillsAccess();
  const buildPrompt = acpPromptBuilder(host, fileSystem, spec.cli === "opencode" ? { access: skillsAccess, agent: "opencode" } : undefined);
  const adapter = yield* makeAcpAdapterV2(acpAdapterOptions(instanceId, acpFlavor(spec.cli, spec.driver, { buildPrompt }), continuationRequests)).pipe(
    Effect.provideService(McpProviderSessions.McpProviderSessions, relayed),
  );
  return {
    instanceId,
    driverKind: spec.driver,
    continuationIdentity,
    displayName,
    accentColor,
    enabled,
    snapshot,
    // SPI-1151: the Workspace's Repo skills and commands at the CLI's roots, from the Workspace DO (never a spawn).
    // OpenCode's repo commands are not listed: over ACP their reply never reaches t3 (stage pcli).
    snapshotForCwd: cliSnapshotForCwdOf({ machine: snapshot.getSnapshot, driver: spec.driver, instanceId, agent: spec.cli, access: skillsAccess, repoCommands: spec.cli !== "opencode" }),
    orchestrationAdapter: wrapCliAdapter(adapter, { sessions, ...(spec.cli === "claude" ? { rewriteTurnText: claudeMentionRewrite(skillsAccess) } : {}) }),
    textGeneration: makePiDurableTextGeneration(),
  } satisfies ProviderInstance;
});
