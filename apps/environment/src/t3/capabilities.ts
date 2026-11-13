// The descriptor's capability flags, classified (SPI-994, SPI-1012; fragility U4). The stock clients decide which
// features to show from these flags, so the Cloud Environment strips every flag for a feature it does not do. Every key
// of t3's `ExecutionEnvironmentCapabilities` is listed here: `satisfies` makes a key a nightly adds fail typecheck, and
// `test/capabilities.test.ts` says which key to classify. Keep a flag only for a feature that works in the cloud.
import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";

type Classification = { readonly keep: true } | { readonly strip: string };
const keep = { keep: true } as const;
const strip = (why: string): Classification => ({ strip: why });

const SELF_UPDATE = "the Environment is updated by the nightly bump and a deploy, never by itself (ADR-0017)";

export const CAPABILITIES = {
  repositoryIdentity: keep,
  connectionProbe: keep,
  attachmentUploads: keep,
  questionAttachments: keep,
  fileAttachments: keep,
  pullRequests: keep,
  pullRequestChecks: keep,
  sideChats: keep,
  vcsBranchStatus: keep,
  inlineMessageContext: keep,
  requiredWorktreeBootstrap: keep,
  threadSettlement: keep,
  threadAutoSettlement: keep,
  storageCleanup: keep,
  storageCleanupRun: keep,
  databaseStorage: keep,
  otlpEndpointCheck: keep,
  projectWorktreeCleanup: keep,
  settledWorktreeCleanup: keep,
  worktreesDirectory: keep,
  fastWorktreeCheckout: strip("a copy-on-write cache on the host's disk; every worktree is a Workspace of its own (step 2b)"),
  threadAutoSettlementScope: keep,
  threadRestartContinuation: keep,
  projectSettingsOverrides: keep,
  projectProviderInstanceOverrides: keep,
  threadSnooze: keep,
  threadForceStop: keep,
  environmentThemes: keep,
  usageLimitSources: keep,
  providerWorkspaceSnapshotsOnDemand: keep,
  modelCatalogRefresh: keep,
  usagePriceOverrides: keep,
  usageModelAliases: keep,
  threadPinning: keep,
  threadPinReorder: keep,
  threadActiveReorder: keep,
  threadAutoSettleOptOut: keep,
  threadProjectFromScratch: strip("scratch threads are not built: the scratch root is not a Workspace (parity G4)"),
  threadTitleRegeneration: keep,
  threadVisitedTracking: keep,
  threadPullRequestLinking: keep,
  serverResolvedCommandContext: keep,
  threadStop: keep,
  localServerStop: strip("stops a server on the client's machine; the Environment is not one"),
  threadPullRequests: keep,
  threadPullRequestWatch: keep,
  pullRequestStackActions: keep,
  serverSelfUpdate: strip(SELF_UPDATE),
  npmReleaseLookup: strip(`offers an npm update: ${SELF_UPDATE}`),
  serverInstallation: strip(SELF_UPDATE),
  serverSelfUpdateProgress: strip(SELF_UPDATE),
  serverUpdateThreadContinuation: strip(SELF_UPDATE),
  // Read per request from T3 Connect's link state; step 3+ (the publish-only link) needs it.
  agentActivityPublishing: keep,
  projectCloneTracking: keep,
  projectOrganization: keep,
  ignoredFileListing: keep,
  environmentIcon: keep,
  desktopAppUpdate: strip("the desktop app's own updater, on a desktop host"),
  desktopAppChannelSwitch: strip("the desktop app's own updater, on a desktop host"),
  commandOutputStreaming: keep,
  serverBrowser: strip("headless Chromium on the host; previews come later (SPI-1002)"),
  peerLinks: keep,
  mcpModeLimitHeader: keep,
  linkFence: keep,
  mcpApprovalCodes: keep,
  mcpHostedApproval: keep,
  triage: strip("clones t3's source and writes host diagnostics on the host (host-bound)"),
  oneTimeSchedules: keep,
  freshContext: keep,
  scheduledTaskThreadModes: keep,
  voiceTranscription: strip("speech models on the host's CPU"),
  // A vendor key typed into t3's settings, called over fetch (D5 lifted, owner 2026-11-12, back to stock).
  cloudVoiceTranscription: keep,
  // The thread shell's families and older settled threads: t3's own `/ws` reads over its own SQL.
  shellThreadFamilies: keep,
  shellOlderSettled: keep,
} as const satisfies Record<keyof ExecutionEnvironmentCapabilities, Classification>;

/** The capabilities the Cloud Environment advertises: t3's, without the stripped ones. */
export const cloudCapabilities = (capabilities: ExecutionEnvironmentCapabilities): ExecutionEnvironmentCapabilities =>
  Object.fromEntries(
    Object.entries(capabilities).filter(([key]) => {
      const classification: Classification | undefined = (CAPABILITIES as Record<string, Classification>)[key];
      // A key t3 sends that its schema does not list: kept, as the client reads it (the schema check catches the rest).
      return classification === undefined || "keep" in classification;
    }),
  ) as ExecutionEnvironmentCapabilities;
