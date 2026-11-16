// The admin leak check's endpoint keys (SPI-1167): every Model endpoint's key, by name, for a Workspace DO's
// `leakCheck({ credentials, patterns })` to look for. Read through the relay's own target, so the key is the one the relay sends.
// A sign-in's (SPI-1171) are its tokens as the Credential broker holds them, access and refresh (a Copilot sign-in's
// refresh token is its GitHub token), read without renewing, and given only as their hashes (`patterns`): none leaves
// the Environment by value, and none may be in the Container.
import { isSignIn, type ModelEndpoints } from "@t3flare/models/endpoints";
import type { ModelRelayTarget } from "@t3flare/models/relay";
import { type CredentialPattern, patternOf } from "@t3flare/sandbox-image/leakscan";

export interface LeakKeySource {
  readonly endpoints: () => Promise<ModelEndpoints>;
  readonly target: (endpointId: string) => Promise<ModelRelayTarget>;
  /** A sign-in's tokens as stored, by name (`CredentialBroker.secrets`); none when it is not signed in. */
  readonly signIn: (endpointId: string) => Promise<ReadonlyArray<{ readonly name: string; readonly value: string }>>;
}

export interface LeakCredentials {
  /** Each endpoint's key as `endpoint:<id>`: looked for by value in the DO's files, by hash in the Container. */
  readonly credentials: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  /** Each sign-in's tokens as `sign-in:<id>:<which>`, hashed here: looked for in the Container only. */
  readonly patterns: ReadonlyArray<CredentialPattern>;
}

/** Every endpoint's key, and every sign-in's tokens as hashes; none for an endpoint without one. */
export const endpointLeakCredentials = async (source: LeakKeySource): Promise<LeakCredentials> => {
  const credentials: Array<{ name: string; value: string }> = [];
  const patterns: Array<CredentialPattern> = [];
  for (const endpoint of (await source.endpoints()).endpoints) {
    if (isSignIn(endpoint.auth)) {
      for (const token of await source.signIn(endpoint.id)) patterns.push(await patternOf(token.name, token.value));
      continue;
    }
    const target = await source.target(endpoint.id);
    if (target.ok && target.key !== null) credentials.push({ name: `endpoint:${endpoint.id}`, value: target.key });
  }
  return { credentials, patterns };
};
