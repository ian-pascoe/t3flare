// The admin leak check's endpoint keys (SPI-1167): every Model endpoint's key, by name, for a Workspace DO's
// `leakCheck({ credentials })` to look for. Read through the relay's own target, so the key is the one the relay sends.
// A sign-in's (SPI-1171) are its tokens as the Credential broker holds them, access and refresh (a Copilot sign-in's
// refresh token is its GitHub token), read without renewing: none may be in the Container.
import { isSignIn, type ModelEndpoints } from "@t3flare/models/endpoints";
import type { ModelRelayTarget } from "@t3flare/models/relay";

export interface LeakKeySource {
  readonly endpoints: () => Promise<ModelEndpoints>;
  readonly target: (endpointId: string) => Promise<ModelRelayTarget>;
  /** A sign-in's tokens as stored, by name (`CredentialBroker.secrets`); none when it is not signed in. */
  readonly signIn: (endpointId: string) => Promise<ReadonlyArray<{ readonly name: string; readonly value: string }>>;
}

/** Each endpoint's key as `endpoint:<id>`, each sign-in's tokens as `sign-in:<id>:<which>`; none for an endpoint without one. */
export const endpointLeakCredentials = async (source: LeakKeySource): Promise<ReadonlyArray<{ readonly name: string; readonly value: string }>> => {
  const credentials: Array<{ name: string; value: string }> = [];
  for (const endpoint of (await source.endpoints()).endpoints) {
    if (isSignIn(endpoint.auth)) {
      credentials.push(...(await source.signIn(endpoint.id)));
      continue;
    }
    const target = await source.target(endpoint.id);
    if (target.ok && target.key !== null) credentials.push({ name: `endpoint:${endpoint.id}`, value: target.key });
  }
  return credentials;
};
