// @effect-diagnostics globalFetch:off globalDate:off globalTimers:off effectFnOpportunity:off cryptoRandomUUID:off
// CLI updates from t3's stock provider-update button (ADR-0037; in-app updates plan D21, D22): the pi CLI, Codex and
// Claude Code each get a real `update` capability on a stage with an update target (D14; docs/deploy.md), whose command is
// `t3flare-cli-update <cli>`. t3's `ProviderMaintenanceRunner` runs it through the `ChildProcessSpawner`, which is our
// process router: it dispatches `cli-bump.yml` and blocks while it follows the run (t3's 30-minute timeout). CI resolves
// the CLI's newest version, edits the image's pin, proves it on the `bump` stage and lands it; the prod deploy restarts
// the Environment, and the card then shows the new version. A failed run exits 1 with its failed step and URL.
//
// `lookupLatestVersion` is the advisory the card compares the pin with (latest only, from npm; t3's
// `ProviderLatestVersions` caches it): `@openai/codex` (its versions are the `rust-v*` releases),
// `@earendil-works/pi-coding-agent`, and the `claudeCodeVersion` of the Claude Agent SDK the newest
// `@agentclientprotocol/claude-agent-acp` pins. Pi Durable is ours and has no update; OpenCode stays manual (its 2.x
// line is not on npm).
import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { CLIS } from "@t3flare/sandbox-image/clis";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";

import { environmentServices } from "../agents/bindings.ts";
import { isUpdatableCli, pinVersionOf, type UpdatableCli } from "./pins.ts";
import { NO_UPDATE_TARGET, type Updates } from "./records.ts";

/** The command t3's runner spawns; the process router answers it (`agents/processRouter.ts`). */
export const CLI_UPDATE_COMMAND = "t3flare-cli-update";
/** The environment variable carrying this isolate's update token (review A4). */
export const CLI_UPDATE_TOKEN_ENV = "T3FLARE_CLI_UPDATE_TOKEN";

let token: string | undefined;
/**
 * This isolate's token for `t3flare-cli-update` (review A4). Other t3 paths spawn commands a client can set (a custom
 * text generator's command, a project's setup script), so the router answers the command only with this token in its
 * environment. It goes into the update capability's `env`, which t3's runner passes to the spawn and never sends to a
 * client (the advisory carries only the display command; the running message only the executable and argv). Made at
 * first use: workerd forbids randomness at module load.
 */
export const cliUpdateToken = (): string => (token ??= crypto.randomUUID());
export const CLI_UPDATE_WORKFLOW = "cli-bump.yml";
export const cliUpdateRunName = (id: string) => `CLI update ${id}`;

const CLI_LABELS: Record<UpdatableCli, string> = { pi: "the pi CLI", codex: "Codex", claude: "Claude Code" };

/** How long one npm request may take (t3's own lookup allows 4 s). */
const LOOKUP_TIMEOUT_MS = 4_000;
/** How often the command reads its run. */
const POLL_MS = 20_000;
/** The command gives up a little after t3's runner (30 minutes) would kill it. */
const COMMAND_DEADLINE_MS = 31 * 60_000;


type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const npmDocument = async (fetchFn: Fetch, path: string): Promise<Record<string, unknown> | null> => {
  const response = await fetchFn(`https://registry.npmjs.org/${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  return response.ok ? ((await response.json()) as Record<string, unknown>) : null;
};

const stringField = (document: Record<string, unknown> | null, field: string): string | null => {
  const value = document?.[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

/** The newest version of `cli` as its card compares it with the pin, or null when npm does not say. */
export const lookupLatestCliVersion = async (cli: UpdatableCli, fetchFn: Fetch = (url, init) => fetch(url, init)): Promise<string | null> => {
  try {
    if (cli === "codex") return stringField(await npmDocument(fetchFn, "@openai%2Fcodex/latest"), "version");
    if (cli === "pi") return stringField(await npmDocument(fetchFn, `${CLIS.pi.package.replace("/", "%2F")}/latest`), "version");
    const adapter = await npmDocument(fetchFn, `${CLIS.claude.package.replace("/", "%2F")}/latest`);
    const range = (adapter?.dependencies as Record<string, unknown> | undefined)?.["@anthropic-ai/claude-agent-sdk"];
    const sdk = typeof range === "string" ? /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(range)?.[0] : undefined;
    if (sdk === undefined) return null;
    return stringField(await npmDocument(fetchFn, `@anthropic-ai%2Fclaude-agent-sdk/${sdk}`), "claudeCodeVersion");
  } catch {
    return null;
  }
};

/** The stage's Updates, or undefined where it has no update target. */
const configuredUpdates = (): Updates | undefined => {
  const updates = environmentServices().updates;
  return updates?.configured === true ? updates : undefined;
};

/**
 * `cli`'s maintenance capabilities: with an update target, a real `update` (`t3flare-cli-update <cli>`, its own lock key)
 * and the npm advisory; without one, manual-only as before (ADR-0024).
 */
export const cliMaintenance = (provider: ProviderDriverKind, cli: UpdatableCli, options: { readonly configured?: boolean; readonly fetch?: Fetch } = {}): ProviderMaintenanceCapabilities =>
  (options.configured ?? configuredUpdates() !== undefined)
    ? makeProviderMaintenanceCapabilities({
        provider,
        packageName: null,
        updateExecutable: CLI_UPDATE_COMMAND,
        updateArgs: [cli],
        updateLockKey: `t3flare-cli:${cli}`,
        platform: "linux",
        env: { [CLI_UPDATE_TOKEN_ENV]: cliUpdateToken() },
        latestVersion: null,
        lookupLatestVersion: Effect.promise(() => lookupLatestCliVersion(cli, options.fetch)),
      })
    : makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null });

/**
 * The managed provider's `enrichSnapshot` for a CLI with an update: t3's version advisory against the latest version
 * (`behind_latest` shows the card's Update button). Undefined without an update, as before.
 */
export const cliVersionAdvisory = (maintenance: ProviderMaintenanceCapabilities) =>
  Effect.gen(function* () {
    if (maintenance.update === null) return undefined;
    // Optional services: t3's hydration provides both (stock drivers need them); a test's bare context has neither.
    const httpClientOption = yield* Effect.serviceOption(HttpClient.HttpClient);
    const latestVersionsOption = yield* Effect.serviceOption(ProviderLatestVersions.ProviderLatestVersions);
    if (Option.isNone(httpClientOption) || Option.isNone(latestVersionsOption)) return undefined;
    const httpClient = httpClientOption.value;
    const latestVersions = latestVersionsOption.value;
    return (input: {
      readonly settings: { readonly enableProviderUpdateChecks?: boolean | undefined };
      readonly snapshot: ServerProvider;
      readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
    }) =>
      enrichProviderSnapshotWithVersionAdvisory(input.snapshot, maintenance, { enableProviderUpdateChecks: input.settings.enableProviderUpdateChecks }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        Effect.flatMap(input.publishSnapshot),
      );
  });

export interface CommandAnswer {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly detail?: string;
}

/**
 * `t3flare-cli-update <cli>`: press the CLI's Update (a re-press joins the run in flight), then follow its run until it
 * ends. Exit 0 once it landed (the prod deploy usually restarts the Environment first), 1 with the reason otherwise.
 */
export const runCliUpdate = async (
  argv: ReadonlyArray<string>,
  options: { readonly updates?: Updates | undefined; readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<CommandAnswer> => {
  const cli = argv[0];
  if (!isUpdatableCli(cli) || argv.length !== 1) return { exitCode: 2, stdout: "", stderr: `usage: ${CLI_UPDATE_COMMAND} pi|codex|claude\n` };
  const updates = "updates" in options ? options.updates : configuredUpdates();
  if (updates === undefined) return { exitCode: 1, stdout: "", stderr: `${NO_UPDATE_TARGET}\n` };
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  let pressed;
  try {
    pressed = await updates.press({
      key: `cli:${cli}`,
      target: "latest",
      from: CLIS[cli].version,
      label: CLI_LABELS[cli],
      workflow: CLI_UPDATE_WORKFLOW,
      runName: cliUpdateRunName,
      // `running`: the pin this build runs, so CI only deploys when main already holds the newest (review F2).
      inputs: (id) => ({ cli, update_id: id, dry_run: "false", running: pinVersionOf(cli, CLIS) }),
    });
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }
  const id = pressed.record.id;
  for (;;) {
    const record = await updates.settle(`cli:${cli}`).catch(() => updates.record(`cli:${cli}`));
    if (record === undefined || record.id !== id) return { exitCode: 1, stdout: "", stderr: `The update of ${CLI_LABELS[cli]} lost its record.\n` };
    if (record.outcome !== null) {
      return record.outcome.status === "succeeded"
        ? { exitCode: 0, stdout: `Landed ${CLI_LABELS[cli]}'s update; prod restarts on it. ${record.outcome.reason}\n`, stderr: "", detail: record.run?.url ?? id }
        : { exitCode: 1, stdout: "", stderr: `${record.outcome.reason}\n`, detail: record.run?.url ?? id };
    }
    if (now() - started > COMMAND_DEADLINE_MS) {
      return { exitCode: 1, stdout: "", stderr: `The update of ${CLI_LABELS[cli]} is still running${record.run === null ? "" : `: ${record.run.url}`}. Press Update again to follow it.\n` };
    }
    await sleep(POLL_MS);
  }
};

/**
 * Whether a spawn is t3's provider-update runner running a CLI update (review A4): exactly `t3flare-cli-update <cli>`,
 * with this isolate's token in its environment. Anything else is not answered (a missing binary).
 */
export const isCliUpdateSpawn = (command: string, argv: ReadonlyArray<string>, env: Readonly<Record<string, unknown>> | undefined): boolean =>
  command === CLI_UPDATE_COMMAND && argv.length === 1 && isUpdatableCli(argv[0]) && token !== undefined && env?.[CLI_UPDATE_TOKEN_ENV] === token;
