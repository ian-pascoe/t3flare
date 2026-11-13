// The Environment skill set a Workspace holds (SPI-1148): the files its read-only mount at `SKILLS_MOUNT` serves, kept
// in the Workspace DO's own storage, one value per file. Empty until one is handed over (`WorkspaceDO.takeEnvironmentSkills`).
// Ported from cloudpid@47941c7c (`apps/server/src/workspace/skill-set.ts`).
import { type EagerMount, type MountWriteAPI, WorkerBundle } from "@cloudflare/computer";
import { EMPTY_SKILL_SET, type SkillSet } from "@t3flare/skills";

/** Where the held set's hash is kept; absent, the Workspace holds the empty set. */
const HASH_KEY = "t3flare:skills:hash";

/** Where each file of the held set is kept, under `<prefix><path>`, as its UTF-8 bytes (one value per file). */
const FILE_PREFIX = "t3flare:skills:file:";

export interface SkillSetStorage {
  readonly kv: SyncKvStorage;
  readonly transactionSync: <T>(closure: () => T) => T;
}

/** The mount serving `set`, as computer's `WorkerBundle` (read-only; its version is the set's hash). */
const mountOf = (set: SkillSet): EagerMount => WorkerBundle({ version: set.hash, files: set.files });

/** The skill set kept in `storage`, read once per instance and replaced as a whole. */
export const skillSetStore = (storage: SkillSetStorage) => {
  let held: SkillSet | undefined;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const load = (): SkillSet => {
    const hash = storage.kv.get<string>(HASH_KEY);
    if (hash === undefined) return EMPTY_SKILL_SET;
    const files: Record<string, string> = {};
    for (const [key, content] of storage.kv.list<Uint8Array>({ prefix: FILE_PREFIX })) files[key.slice(FILE_PREFIX.length)] = decoder.decode(content);
    return { hash, files };
  };
  return {
    current: (): SkillSet => (held ??= load()),
    /** Keeps `set` in place of the one held, in one transaction. The empty set is kept as nothing. */
    replace: (set: SkillSet): void => {
      storage.transactionSync(() => {
        for (const [key] of storage.kv.list({ prefix: FILE_PREFIX })) storage.kv.delete(key);
        storage.kv.delete(HASH_KEY);
        if (set.hash === EMPTY_SKILL_SET.hash) return;
        for (const [path, content] of Object.entries(set.files)) storage.kv.put(`${FILE_PREFIX}${path}`, encoder.encode(content));
        storage.kv.put(HASH_KEY, set.hash);
      });
      held = set;
    },
  };
};

/**
 * The read-only mount of the set `current` answers: its version is the set's hash, so computer copies the files again
 * (clearing the mount first) only when the hash differs from the one it recorded, at the first index of each instance
 * and at each `remount()` (computer patched, `patches/deps/@cloudflare__computer@0.11.2.patch`).
 */
export const skillSetMount = (current: () => SkillSet): EagerMount => ({
  kind: "skill-set",
  mode: "read-only",
  strategy: "eager",
  version: async () => current().hash,
  materialize: (api: MountWriteAPI) => mountOf(current()).materialize(api),
});
