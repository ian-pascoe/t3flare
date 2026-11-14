// The Model endpoints' keys the Workspace DO looks for (SPI-1167): the sync guard looks for those the model relay used
// here, and the leak check for those the admin route gives it. In the Container a key is looked for by its prefix,
// length and SHA-256 (`patternOf`), which go into the scanner's argv; a key shorter than `MIN_SCANNED_KEY_LENGTH` is
// never scanned for there, since its hash could be reversed by search from what any process may read. The DO's own
// files are searched by value, which never leaves the DO.
import { type CredentialPattern, patternOf } from "@t3flare/sandbox-image/leakscan";

/** Keys shorter than this are not scanned for in the Container (their unsalted hash would give them away). */
export const MIN_SCANNED_KEY_LENGTH = 20;

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

/**
 * What a leak check looks for, of `credentials`: every value in the DO's files, and the patterns of those long enough
 * to scan for in the Container.
 */
export const leakTargets = async (
  credentials: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): Promise<{ readonly values: ReadonlyArray<readonly [string, string]>; readonly patterns: ReadonlyArray<CredentialPattern> }> => {
  const values = credentials.filter((credential) => credential.value.length >= 8).map((credential) => [credential.name, credential.value] as const);
  const patterns = await Promise.all(credentials.filter((credential) => credential.value.length >= MIN_SCANNED_KEY_LENGTH).map((credential) => patternOf(credential.name, credential.value)));
  return { values, patterns };
};
