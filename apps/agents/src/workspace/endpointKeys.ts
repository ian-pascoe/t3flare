// The Model endpoints' keys the Workspace DO looks for (SPI-1167): the sync guard looks for those the model relay used
// here, and the leak check for those the admin route gives it. In the Container a key is looked for by its prefix,
// length and SHA-256 (`patternOf`), which go into the scanner's argv; a key shorter than `MIN_SCANNED_KEY_LENGTH` is
// never scanned for there, since its hash could be reversed by search from what any process may read. The DO's own
// files are searched by value, which never leaves the DO.
import { type CredentialPattern, MIN_SCANNED_LENGTH, patternOf } from "@t3flare/sandbox-image/leakscan";

/** Keys shorter than this are not scanned for in the Container (their unsalted hash would give them away). */
export const MIN_SCANNED_KEY_LENGTH = MIN_SCANNED_LENGTH;

/** The relay's keys by endpoint, by hash: one per endpoint, the newest, at most `MAX_ENDPOINT_KEYS`. */
export const MAX_ENDPOINT_KEYS = 32;

export class EndpointKeyPatterns {
  readonly #patterns = new Map<string, CredentialPattern>();

  async remember(endpointId: string, key: string): Promise<void> {
    if (key.length < MIN_SCANNED_KEY_LENGTH) return;
    const pattern = await patternOf(`endpoint:${endpointId}`, key);
    if (this.#patterns.get(endpointId)?.sha256 === pattern.sha256) return;
    this.#patterns.delete(endpointId);
    this.#patterns.set(endpointId, pattern);
    if (this.#patterns.size > MAX_ENDPOINT_KEYS) this.#patterns.delete(this.#patterns.keys().next().value!);
  }

  values(): ReadonlyArray<CredentialPattern> {
    return [...this.#patterns.values()];
  }
}

/** Values shorter than this are not searched for in the DO's files either (too short to tell from ordinary text). */
export const MIN_SEARCHED_VALUE_LENGTH = 8;

/**
 * What a leak check looks for, of `credentials`: every value in the DO's files, and the patterns of those long enough
 * to scan for in the Container. `skipped` names (never shows) each credential left out somewhere, so a skip is never
 * read as a clean scan.
 */
export const leakTargets = async (
  credentials: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  hashed: ReadonlyArray<CredentialPattern> = [],
): Promise<{
  readonly values: ReadonlyArray<readonly [string, string]>;
  readonly patterns: ReadonlyArray<CredentialPattern>;
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly where: "container" | "everywhere" }>;
  /** Credentials looked for in the Container only, not in the DO's files (a sign-in's tokens, given as hashes), by name. */
  readonly containerOnly: ReadonlyArray<string>;
}> => {
  const values = credentials.filter((credential) => credential.value.length >= MIN_SEARCHED_VALUE_LENGTH).map((credential) => [credential.name, credential.value] as const);
  const patterns = await Promise.all(credentials.filter((credential) => credential.value.length >= MIN_SCANNED_KEY_LENGTH).map((credential) => patternOf(credential.name, credential.value)));
  const skipped = credentials
    .filter((credential) => credential.value.length < MIN_SCANNED_KEY_LENGTH)
    .map((credential) => ({ name: credential.name, where: credential.value.length < MIN_SEARCHED_VALUE_LENGTH ? ("everywhere" as const) : ("container" as const) }));
  // SPI-1171: a sign-in's tokens come as their patterns only (the Environment hashes them): never a value here, so they
  // are scanned for in the Container and not in the DO's files (`containerOnly` names them). What reaches the DO's files
  // passes the sync guard, which looks only for the newest access token the relay used per endpoint, kept in memory, never
  // a refresh token. One that is malformed or too short is named in `skipped`, not scanned.
  const scannable = (pattern: CredentialPattern) =>
    pattern.length >= MIN_SCANNED_KEY_LENGTH && pattern.prefix.length <= 4 && pattern.prefix.length < pattern.length && /^[0-9a-f]{64}$/.test(pattern.sha256);
  return {
    values,
    patterns: [...patterns, ...hashed.filter(scannable)],
    skipped: [...skipped, ...hashed.filter((pattern) => !scannable(pattern)).map((pattern) => ({ name: pattern.name, where: "everywhere" as const }))],
    containerOnly: hashed.filter(scannable).map((pattern) => pattern.name),
  };
};
