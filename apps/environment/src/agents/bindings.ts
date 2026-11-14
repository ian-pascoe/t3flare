// What the Environment DO hands t3's code that is not a t3 service (step 1's note: expose what 2a needs deliberately):
// the agents Worker's Durable Object bindings, the model proxy and its model catalog, and the GitHub minter. Set by the DO's constructor, before
// t3 boots; module state, as the DO is the only one in its isolate.
import type { ModelCatalog } from "@t3flare/models/catalog";
import type { GitHubTokens } from "./github.ts";
import type { AgentsBindings } from "./rpc.ts";
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

import type { SweepSettings } from "./deletion.ts";
import type { SkillStore } from "../skills/store.ts";
import type { WorkspaceRegistry } from "./workspaces.ts";
import type { ProcessChannel } from "./processChannel.ts";
import type { CommissaryManagement } from "../usage/commissary.ts";
import type { BrowserRunBinding, BrowserRunFetcher } from "../preview/browserRun.ts";
import type { PreviewStore } from "../preview/store.ts";

export interface EnvironmentServices {
  readonly agents: AgentsBindings;
  readonly modelProxy: { readonly url: string; readonly apiKey: string } | undefined;
  /** The proxy's model list, kept in the DO's storage (ADR-0012). */
  readonly catalog: ModelCatalog;
  readonly github: () => GitHubTokens;
  readonly workspaces: WorkspaceRegistry;
  /** The Environment DO's SQLite (t3's projection, read by the deletion's reference check). */
  readonly sql: SqlStorage;
  readonly sweep: SweepSettings;
  /** One-time marks in the Environment DO's storage (step 3: a setting seeded once, L1). */
  readonly marks: { has(key: string): boolean; set(key: string): void };
  /** Step 4a: this instance's CLI processes (review F6: never module state). */
  readonly processes: ProcessChannel;
  /** Test stages: stage-only probes and faults answer. */
  readonly faults: boolean;
  /** The MCP servers a CLI process gets relay entries for (ADR-0028), at its spawn; a linked thread's are M13's. */
  readonly relayServers: () => ReadonlyArray<string>;
  /** SPI-1147: the Harness `skills` switch, as the stored settings resolve it now. */
  readonly skillsEnabled: () => boolean;
  /** SPI-1148: the Environment skills kept here (their rows, the enabled set's hash). */
  readonly environmentSkills: () => SkillStore;
  /** t3's `/mcp` at the public host, as a CLI in a Container reaches it with t3's per-thread bearer. */
  readonly t3McpUrl: () => string;
  /** t3's public origin (`https://<t3 host>`), or null where no host is configured (local workerd): task webhooks' base (parity G12). */
  readonly publicOrigin: () => string | null;
  /** Commissary's management API for t3's Usage page and limit meters (parity G8), or undefined when not set. */
  readonly commissary: CommissaryManagement | undefined;
  /** G11 (ADR-0031): the Browser Run binding, or undefined where none is bound (local workerd, tests). */
  readonly browserRun: BrowserRunBinding | undefined;
  /** G11: the `ContainerPreviews` entrypoint made for one Workspace, as a preview browser's `outboundByHost` target. */
  readonly containerPreviews: (workspace: string) => BrowserRunFetcher;
  /** G11: the Browser Run sessions this Environment holds, and the server browser's profiles (`preview/store.ts`). */
  readonly previewStore: PreviewStore;
}

let current: EnvironmentServices | undefined;

export const bindEnvironmentServices = (services: EnvironmentServices): void => {
  current = services;
};

export const environmentServices = (): EnvironmentServices => {
  if (current === undefined) throw new Error("t3flare: the Environment DO has not bound its services");
  return current;
};
