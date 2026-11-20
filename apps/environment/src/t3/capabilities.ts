// The descriptor's capability flags, classified (SPI-994, SPI-1012; fragility U4). The stock clients decide which
// features to show from these flags, so the Cloud Environment strips every flag for a feature it does not do. Keep a
// flag only for a feature that works in the cloud.
//
// A flag a nightly adds is stripped until it is classified here: the client then hides that feature, as it does for an
// older server. That keeps a new flag from blocking the bump, and t3 adds several a week. The bump reports each one
// (`scripts/capabilities-unclassified.ts`, in the report and the bump PR's body) to be classified. `satisfies` still
// fails typecheck on a key t3 no longer has, or a misspelt one.
//
// Three classifications (ADR-0023): kept (t3's own value goes out), stripped, and advertised by t3flare: a value t3 never
// sends in the DO (it has no launcher or desktop app), which t3flare sends itself where its own code does the feature.
import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";

type Classification = { readonly keep: true } | { readonly strip: string } | { readonly advertise: string };
const keep = { keep: true } as const;
const strip = (why: string): Classification => ({ strip: why });
const advertise = (why: string): Classification => ({ advertise: why });

const SELF_UPDATE = "the Environment is updated by the nightly bump and a deploy, never by itself (ADR-0017)";
/** What a stock client's server Update does here (ADR-0037): the DO dispatches CI, which proves and lands the bump. */
const UPDATE_BY_CI = "a stock client's server Update dispatches a t3 bump that CI proves and lands (ADR-0037); t3flare's own ServerSelfUpdate answers it";

export const CAPABILITIES = {
  repositoryIdentity: keep,
  connectionProbe: keep,
  // Not yet proven here: no acceptance check pairs with a DPoP key, and a client that sees the flag fails pairing when the
  // exchange does. Absent, clients pair with a bearer, as before t3 added it.
  accessTokenRenewal: strip("DPoP pairing and renewal at /oauth/token is not exercised by the acceptance test yet"),
  attachmentUploads: keep,
  questionAttachments: keep,
  fileAttachments: keep,
  pullRequests: keep,
  pullRequestChecks: keep,
  // t3's issue trackers: a git host's through the stock source-control drivers (as pull requests), Linear over fetch
  // with its key in the DO's secret store.
  issues: keep,
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
  // Settings' check button: a fresh read through the SecretResolver the Environment already uses.
  secretSourceCheck: keep,
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
  // The No project folder is the Workspace `/w/t3-scratch` (Patch 0004, parity G4), so its threads can become projects.
  threadProjectFromScratch: keep,
  threadTitleRegeneration: keep,
  threadVisitedTracking: keep,
  threadPullRequestLinking: keep,
  serverResolvedCommandContext: keep,
  threadStop: keep,
  // G11 (ADR-0031): a listed server in a Workspace's Container, stopped by its process group (`preview/portDiscovery.ts`).
  localServerStop: keep,
  threadPullRequests: keep,
  threadPullRequestWatch: keep,
  pullRequestStackActions: keep,
  // `respawn`, not `boot-service`: the client then takes no accepting-`ready` baseline, so an idle reset during the
  // update does not read as its failure (in-app updates plan D2). Only on a stage with an update target (D14).
  serverSelfUpdate: advertise(UPDATE_BY_CI),
  npmReleaseLookup: strip(`offers an npm update: ${SELF_UPDATE}`),
  serverInstallation: strip(SELF_UPDATE),
  serverSelfUpdateProgress: strip(SELF_UPDATE),
  serverUpdateStaging: strip(SELF_UPDATE),
  serverUpdateThreadContinuation: strip(SELF_UPDATE),
  // Read per request from T3 Connect's link state; step 3+ (the publish-only link) needs it.
  agentActivityPublishing: keep,
  projectCloneTracking: keep,
  projectOrganization: keep,
  ignoredFileListing: keep,
  ignoredFileSearch: keep,
  environmentIcon: keep,
  desktopAppUpdate: strip("the desktop app's own updater, on a desktop host"),
  desktopAppChannelSwitch: strip("the desktop app's own updater, on a desktop host"),
  commandOutputStreaming: keep,
  // G11 (ADR-0031): t3's server browser runs in Browser Run, with `localhost` routed to the thread's Container.
  serverBrowser: keep,
  peerLinks: keep,
  mcpModeLimitHeader: keep,
  linkFence: keep,
  mcpApprovalCodes: keep,
  // Automatic pairing codes bound to a Peer link (step 3's links, as `peerLinks`).
  peerLinkPairingCodes: keep,
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
  // t3 publishes a pull request refresh when a linked thread's answers change: its own `/ws` push.
  linkedThreadRefreshes: keep,
  // `issues.linkedThreads`: t3's own `/ws` read over its own SQL, through the ported ThreadIssueService.
  issueLinkedThreads: keep,
  // The switch for t3's preview tunnel, which is not mounted here; the managed policy keeps the tunnel off on every client.
  previewTunnelSetting: strip("the preview tunnel reaches the host's loopback ports, where nothing listens in the DO (host-bound)"),
} as const satisfies { readonly [K in keyof ExecutionEnvironmentCapabilities]?: Classification };

/** The flags of t3's descriptor (`fields`, its schema's keys) that are not classified here: each is stripped. */
export const unclassifiedCapabilities = (fields: ReadonlyArray<string>): Array<string> => fields.filter((key) => !Object.hasOwn(CAPABILITIES, key));

/** The values t3flare advertises for its `advertise` keys, each sent only where its feature is configured. */
export interface AdvertisedCapabilities {
  /** Set on a stage with an update target (prod; plan D14): a press elsewhere would move prod. */
  readonly serverSelfUpdate?: "respawn";
}

/** The capabilities the Cloud Environment advertises: t3's kept ones, and t3flare's own where configured. */
export const cloudCapabilities = (capabilities: ExecutionEnvironmentCapabilities, advertised: AdvertisedCapabilities = {}): ExecutionEnvironmentCapabilities =>
  ({
    ...Object.fromEntries(
      Object.entries(capabilities).filter(([key]) => {
        const classification: Classification | undefined = (CAPABILITIES as Record<string, Classification>)[key];
        // Unclassified (a flag a nightly added, or one t3 sends that its schema does not list): stripped until classified.
        return classification !== undefined && "keep" in classification;
      }),
    ),
    ...Object.fromEntries(
      Object.entries(advertised).filter(([key, value]) => value !== undefined && "advertise" in (CAPABILITIES as Record<string, Classification>)[key]!),
    ),
  }) as ExecutionEnvironmentCapabilities;
