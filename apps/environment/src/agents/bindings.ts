// What the Environment DO hands t3's code that is not a t3 service (step 1's note: expose what 2a needs deliberately):
// the agents Worker's Durable Object bindings, the model proxy and its model catalog, and the GitHub minter. Set by the DO's constructor, before
// t3 boots; module state, as the DO is the only one in its isolate.
import type { ModelCatalog } from "@t3flare/models/catalog";
import type { GitHubTokens } from "./github.ts";
import type { AgentsBindings } from "./rpc.ts";
import type { WorkspaceRegistry } from "./workspaces.ts";

export interface EnvironmentServices {
  readonly agents: AgentsBindings;
  readonly modelProxy: { readonly url: string; readonly apiKey: string } | undefined;
  /** The proxy's model list, kept in the DO's storage (ADR-0012). */
  readonly catalog: ModelCatalog;
  readonly github: () => GitHubTokens;
  readonly workspaces: WorkspaceRegistry;
}

let current: EnvironmentServices | undefined;

export const bindEnvironmentServices = (services: EnvironmentServices): void => {
  current = services;
};

export const environmentServices = (): EnvironmentServices => {
  if (current === undefined) throw new Error("t3flare: the Environment DO has not bound its services");
  return current;
};
