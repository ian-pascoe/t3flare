// The admin leak check's endpoint keys (SPI-1167): every Model endpoint's key, by name, for a Workspace DO's
// `leakCheck({ credentials })` to look for. Read through the relay's own target, so the key is the one the relay sends.
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import type { ModelRelayTarget } from "@t3flare/models/relay";

export interface LeakKeySource {
  readonly endpoints: () => Promise<ModelEndpoints>;
  readonly target: (endpointId: string) => Promise<ModelRelayTarget>;
}

/** Each endpoint's key as `endpoint:<id>`; an endpoint with no key, or one that no longer opens, has none. */
export const endpointLeakCredentials = async (source: LeakKeySource): Promise<ReadonlyArray<{ readonly name: string; readonly value: string }>> => {
  const credentials: Array<{ name: string; value: string }> = [];
  for (const endpoint of (await source.endpoints()).endpoints) {
    const target = await source.target(endpoint.id);
    if (target.ok && target.key !== null) credentials.push({ name: `endpoint:${endpoint.id}`, value: target.key });
  }
  return credentials;
};
