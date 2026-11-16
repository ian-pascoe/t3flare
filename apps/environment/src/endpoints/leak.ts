// The admin leak check's endpoint keys (SPI-1167): every Model endpoint's key, by name, for a Workspace DO's
// `leakCheck({ credentials, patterns })` to look for. Read through the relay's own target, so the key is the one the relay
// sends. A sign-in's (SPI-1171) are its tokens as the Credential broker holds them, access and refresh (a Copilot
// sign-in's refresh token is its GitHub token), read without renewing and hashed in the Environment DO
// (`signInLeakPatterns`): none leaves it by value, none shorter than the scanner's minimum leaves at all, and none may be
// in the Container.
import { isSignIn, type ModelEndpoints } from "@t3flare/models/endpoints";
import type { ModelRelayTarget } from "@t3flare/models/relay";
import { type CredentialPattern, MIN_SCANNED_LENGTH, patternOf } from "@t3flare/sandbox-image/leakscan";

/** A secret by its name (`endpoint:<id>`, `sign-in:<id>:access`, …): what a leak check looks for. */
export interface NamedSecret {
  readonly name: string;
  readonly value: string;
}

/** A sign-in's tokens as the leak check takes them: hashed, and the names of those too short to hash (never sent). */
export interface SignInLeakPatterns {
  readonly patterns: ReadonlyArray<CredentialPattern>;
  readonly tooShort: ReadonlyArray<string>;
}

/** `secrets` hashed for the Container's scan; one shorter than the scanner's minimum is dropped and named. */
export const signInLeakPatterns = async (secrets: ReadonlyArray<NamedSecret>): Promise<SignInLeakPatterns> => ({
  patterns: await Promise.all(secrets.filter((secret) => secret.value.length >= MIN_SCANNED_LENGTH).map((secret) => patternOf(secret.name, secret.value))),
  tooShort: secrets.filter((secret) => secret.value.length < MIN_SCANNED_LENGTH).map((secret) => secret.name),
});

export interface LeakKeySource {
  readonly endpoints: () => Promise<ModelEndpoints>;
  readonly target: (endpointId: string) => Promise<ModelRelayTarget>;
  /** A sign-in's tokens as hashes (the Environment DO's `signInLeakPatterns`); none when it is not signed in. */
  readonly signIn: (endpointId: string) => Promise<SignInLeakPatterns>;
}

export interface LeakCredentials {
  /** Each endpoint's key as `endpoint:<id>`: looked for by value in the DO's files, by hash in the Container. */
  readonly credentials: ReadonlyArray<NamedSecret>;
  /** Each sign-in's tokens as `sign-in:<id>:<which>`, hashed: looked for in the Container only. */
  readonly patterns: ReadonlyArray<CredentialPattern>;
  /** A sign-in's tokens too short to hash, by name: not looked for at all. */
  readonly notScanned: ReadonlyArray<{ readonly name: string; readonly where: "everywhere" }>;
}

/** Every endpoint's key, and every sign-in's tokens as hashes; none for an endpoint without one. */
export const endpointLeakCredentials = async (source: LeakKeySource): Promise<LeakCredentials> => {
  const credentials: Array<NamedSecret> = [];
  const patterns: Array<CredentialPattern> = [];
  const notScanned: Array<{ readonly name: string; readonly where: "everywhere" }> = [];
  for (const endpoint of (await source.endpoints()).endpoints) {
    if (isSignIn(endpoint.auth)) {
      const hashed = await source.signIn(endpoint.id);
      patterns.push(...hashed.patterns);
      notScanned.push(...hashed.tooShort.map((name) => ({ name, where: "everywhere" as const })));
      continue;
    }
    const target = await source.target(endpoint.id);
    if (target.ok && target.key !== null) credentials.push({ name: `endpoint:${endpoint.id}`, value: target.key });
  }
  return { credentials, patterns, notScanned };
};
