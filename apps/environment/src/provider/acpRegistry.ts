// Parity G13 (SPI-1003): t3's ACP registry in the Cloud Environment. A Layer over t3's `AcpRegistryCatalog` (ADR-0001):
// the registry is listed as stock lists it, and each agent says what t3flare does with it; preparing (installing) one
// is refused with that reason, so no `acpRegistry` provider instance is made that could not run.
//
// What an agent needs here (ADR-0012, ADR-0016 with its A′ decision): a base-URL setting for the model proxy, and a way
// to take the Container's proxy key from t3flare's key helper on demand, never from its environment or a file. Of the
// registry's agents only four have both, and each is already a built-in provider of t3's own kind, running the same
// agent in the Workspace's Container (steps 4a, 4b): Claude Agent, Codex, OpenCode and pi. The rest either sign in with
// their vendor (refused, parity D3) or read their key only from the environment or a settings file (not offered while
// ADR-0016's A′ holds; the owner's call: docs/steps/parity-batch-2.md). So no registry agent is installed, at runtime or
// in the image (ADR-0024's pin is unchanged).
import type { AcpRegistrySearchAgent } from "@t3tools/contracts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Registry agents that are a built-in provider here: the provider to add instead. */
export const BUILT_IN_EQUIVALENT: Readonly<Record<string, string>> = {
  "claude-acp": "Claude",
  "codex-acp": "Codex",
  opencode: "OpenCode",
  "opencode-v2": "OpenCode",
  "pi-acp": "Pi",
};

/**
 * Registry agents that sign in with their vendor's account (parity D3, ADR-0015's refinement): no model proxy base URL.
 * The six of D3 plus the agents whose only documented access is the vendor's own sign-in.
 */
export const VENDOR_SIGN_IN: ReadonlySet<string> = new Set([
  "cursor",
  "antigravity-acp",
  "kiro",
  "grok-build",
  "amp-acp",
  "auggie",
  "github-copilot-cli",
  "devin",
  "factory-droid",
  "junie",
  "qoder",
  "codebuddy-code",
  "cortex-code",
  "poolside",
]);

export type RegistryStanding =
  | { readonly kind: "built-in"; readonly provider: string }
  | { readonly kind: "vendor-sign-in" }
  | { readonly kind: "key-from-environment" };

/** What t3flare does with a registry agent. An agent not named here is judged the last way (the registry grows). */
export const standingOf = (agentId: string): RegistryStanding => {
  const provider = BUILT_IN_EQUIVALENT[agentId];
  if (provider !== undefined) return { kind: "built-in", provider };
  if (VENDOR_SIGN_IN.has(agentId)) return { kind: "vendor-sign-in" };
  return { kind: "key-from-environment" };
};

/** The sentence the registry list leads each agent's description with, and a refused prepare answers. */
export const standingText = (standing: RegistryStanding): string => {
  switch (standing.kind) {
    case "built-in":
      return `Built in here: add the ${standing.provider} provider, which runs this agent in your Workspace on the model proxy.`;
    case "vendor-sign-in":
      return "Not available in t3flare: it signs in with its vendor's account, and t3flare's agents reach models only through the model proxy (decision D3).";
    case "key-from-environment":
      return "Not available in t3flare yet: it takes its model key only from its environment or a settings file, and t3flare gives a Container's agent its proxy key only through a key helper (ADR-0016).";
  }
};

const DESCRIPTION_MAX = 1_024;

/** A search result as listed here: stock's, its description led by the agent's standing. */
export const annotated = (agent: AcpRegistrySearchAgent): AcpRegistrySearchAgent => {
  const lead = standingText(standingOf(agent.id));
  const description = agent.description === "" ? lead : `${lead} ${agent.description}`;
  return { ...agent, description: description.length > DESCRIPTION_MAX ? `${description.slice(0, DESCRIPTION_MAX - 1)}…` : description };
};

const refusal = (agentId: string | undefined) =>
  new AcpRegistrySupport.AcpRegistryError({
    reason: "runner_unavailable",
    detail:
      agentId === undefined
        ? "t3flare runs ACP agents only as its built-in providers (Claude, Codex, OpenCode, Pi): a custom ACP command would run on the Environment's host, which has none."
        : standingText(standingOf(agentId)),
  });

/** t3's catalog with every install refused, by the agent's standing. */
export const refusingCatalog = (stock: AcpRegistrySupport.AcpRegistryCatalog["Service"]): AcpRegistrySupport.AcpRegistryCatalog["Service"] => ({
  search: (input) => stock.search(input).pipe(Effect.map((result) => ({ ...result, agents: result.agents.map(annotated) }))),
  prepare: (input) => Effect.fail(refusal(input.agentId)),
  inspect: (settings) => Effect.fail(refusal(settings.agentId === "" ? undefined : settings.agentId)),
  resolve: (settings) => Effect.fail(refusal(settings.agentId === "" ? undefined : settings.agentId)),
  uninstallManagedBinary: (input) => Effect.succeed({ agentId: input.agentId, removed: false }),
});

/**
 * In place of `AcpRegistrySupport.layerFromHost`: the refusing catalog over t3's (whose search reads the registry), and
 * t3's runtime coordinator.
 */
export const layerAcpRegistry = Layer.merge(
  Layer.effect(
    AcpRegistrySupport.AcpRegistryCatalog,
    Effect.map(Effect.service(AcpRegistrySupport.AcpRegistryCatalog), refusingCatalog),
  ).pipe(Layer.provide(AcpRegistrySupport.layerFromHost)),
  AcpRegistryRuntimeCoordinator.layer,
);
