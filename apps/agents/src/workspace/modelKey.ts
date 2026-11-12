// The key route's gate (step 4a, ADR-0016 A′, review F4): the CLI agents' model key goes only to the nonce of a CLI
// process that lives in this Workspace, a Codex process's at most `CODEX_KEY_GRANTS` times.

/**
 * Grants per Codex process (review F4, measured in M0: Codex asks twice as it starts, then keeps the key across turns;
 * one more covers a 401's re-ask). pi asks at every model request, so its nonce has no count (its shells see it, §4.9).
 */
export const CODEX_KEY_GRANTS = 3;

/**
 * Grants per Claude Code or OpenCode process (step 4b, M0 P1, P2: each asks once, Claude with its 24 h helper TTL and
 * OpenCode's key plugin at load; one more covers a 401's re-ask).
 */
export const ACP_KEY_GRANTS = 2;

const LIMITED: Readonly<Record<string, { readonly grants: number; readonly name: string }>> = {
  codex: { grants: CODEX_KEY_GRANTS, name: "Codex" },
  claude: { grants: ACP_KEY_GRANTS, name: "Claude Code" },
  opencode: { grants: ACP_KEY_GRANTS, name: "OpenCode" },
};

export type KeyDecision = { readonly grant: true; readonly cli: string; readonly key: string; readonly grants: number } | { readonly grant: false; readonly why: string };

export class ModelKeyGate {
  readonly #nonces = new Map<string, { readonly key: string; readonly cli: string; grants: number }>();
  readonly #newNonce: () => string;

  constructor(newNonce: () => string) {
    this.#newNonce = newNonce;
  }

  /** A nonce for a process about to start. */
  issue(key: string, cli: string): string {
    const nonce = this.#newNonce();
    this.#nonces.set(nonce, { key, cli, grants: 0 });
    return nonce;
  }

  /** Whether `nonce` gets the key now; `live` is the keys of the processes that run. */
  decide(nonce: string | null, live: ReadonlySet<string>): KeyDecision {
    for (const [known, entry] of this.#nonces) if (!live.has(entry.key)) this.#nonces.delete(known);
    const entry = nonce === null ? undefined : this.#nonces.get(nonce);
    if (entry === undefined) return { grant: false, why: live.size === 0 ? "no CLI process lives here" : "unknown nonce" };
    const limit = LIMITED[entry.cli];
    if (limit !== undefined && entry.grants >= limit.grants) return { grant: false, why: `${limit.name}'s grants are used up` };
    entry.grants++;
    return { grant: true, cli: entry.cli, key: entry.key, grants: entry.grants };
  }
}
