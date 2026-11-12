// What the Environment DO hands t3's code that is not a t3 service (step 1's note: expose what 2a needs deliberately):
// the agents Worker's Durable Object bindings, the model proxy and its model catalog, and the GitHub minter. Set by the DO's constructor, before
// t3 boots; module state, as the DO is the only one in its isolate.
import type { ModelCatalog } from "@t3flare/models/catalog";
import type { GitHubTokens } from "./github.ts";
import type { AgentsBindings } from "./rpc.ts";
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

import type { SweepSettings } from "./deletion.ts";
import type { WorkspaceRegistry } from "./workspaces.ts";
import type { ProcessChannel } from "./processChannel.ts";

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
  /** t3's `/mcp` at the public host, as a CLI in a Container reaches it with t3's per-thread bearer. */
  readonly t3McpUrl: () => string;
}

let current: EnvironmentServices | undefined;

export const bindEnvironmentServices = (services: EnvironmentServices): void => {
  current = services;
};

export const environmentServices = (): EnvironmentServices => {
  if (current === undefined) throw new Error("t3flare: the Environment DO has not bound its services");
  return current;
};
