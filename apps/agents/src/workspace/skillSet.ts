// The Environment skill set a Workspace holds (SPI-1148, ADR-0033): the files its read-only mount at `SKILLS_MOUNT`
// serves, kept in the Workspace DO's own storage, one value per file, with the set's hash and its parsed listing. The
// instance keeps only the hash and the listing in memory; computer reads the files when it copies them. Empty until one
// is handed over (`WorkspaceDO.takeEnvironmentSkills`). Ported from cloudpid@47941c7c
// (`apps/server/src/workspace/skill-set.ts`).
import { type EagerMount, type MountWriteAPI, WorkerBundle } from "@cloudflare/computer";
import { EMPTY_SKILL_SET, EMPTY_SKILL_SET_HASH, listingOfSet, type Skill, type SkillSet } from "@t3flare/skills";

/** Where the held set's hash is kept; absent, the Workspace holds the empty set. */
const HASH_KEY = "t3flare:skills:hash";
/** The held set's parsed listing: what the model's listing shows. */
const LISTING_KEY = "t3flare:skills:listing";
/** Each file of the held set, under `<prefix><path>`, as its UTF-8 bytes (one value per file). */
const FILE_PREFIX = "t3flare:skills:file:";
/** The last set this Workspace refused, by hash, and why: not read again until the Environment's hash moves. */
const REFUSED_KEY = "t3flare:skills:refused";

export interface SkillSetStorage {
  readonly kv: SyncKvStorage;
  readonly transactionSync: <T>(closure: () => T) => T;
}

export interface SkillSetRefusal {
  readonly hash: string;
  readonly message: string;
}

export type SkillSetStore = ReturnType<typeof skillSetStore>;

/** The skill set kept in `storage`: its hash and listing remembered per instance, its files read when asked. */
export const skillSetStore = (storage: SkillSetStorage) => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let held: { readonly hash: string; readonly listing: ReadonlyArray<Skill> } | undefined;
  const current = () => (held ??= { hash: storage.kv.get<string>(HASH_KEY) ?? EMPTY_SKILL_SET_HASH, listing: storage.kv.get<ReadonlyArray<Skill>>(LISTING_KEY) ?? [] });
  return {
    hash: (): string => current().hash,
    /** The Skills the held set declares, at `SKILLS_MOUNT`. */
    listing: (): ReadonlyArray<Skill> => current().listing,
    /** The held set's files, read from storage now (never kept in memory). */
    files: (): Record<string, string> => {
      const files: Record<string, string> = {};
      for (const [key, content] of storage.kv.list<Uint8Array>({ prefix: FILE_PREFIX })) files[key.slice(FILE_PREFIX.length)] = decoder.decode(content);
      return files;
    },
    /** Keeps `set` in place of the one held, in one transaction. The empty set is kept as nothing. */
    replace: (set: SkillSet): void => {
      const listing = listingOfSet(set.files);
      storage.transactionSync(() => {
        for (const [key] of storage.kv.list({ prefix: FILE_PREFIX })) storage.kv.delete(key);
        storage.kv.delete(HASH_KEY);
        storage.kv.delete(LISTING_KEY);
        if (set.hash === EMPTY_SKILL_SET_HASH) return;
        for (const [path, content] of Object.entries(set.files)) storage.kv.put(`${FILE_PREFIX}${path}`, encoder.encode(content));
        storage.kv.put(HASH_KEY, set.hash);
        storage.kv.put(LISTING_KEY, listing);
      });
      held = { hash: set.hash, listing: set.hash === EMPTY_SKILL_SET_HASH ? [] : listing };
    },
    refused: (): SkillSetRefusal | undefined => storage.kv.get<SkillSetRefusal>(REFUSED_KEY),
    refuse: (refusal: SkillSetRefusal): void => storage.kv.put(REFUSED_KEY, refusal),
    clearRefused: (): void => void storage.kv.delete(REFUSED_KEY),
  };
};

/**
 * The read-only mount of `store`'s set: its version is the set's hash, so computer copies the files again (clearing the
 * mount first) only when the hash differs from the one it recorded, at the first index of each instance and at each
 * `remount()` (computer patched: `patches/deps/@cloudflare__computer@0.11.2.patch`). The files are read at that copy.
 */
export const skillSetMount = (store: Pick<SkillSetStore, "hash" | "files">): EagerMount => ({
  kind: "skill-set",
  mode: "read-only",
  strategy: "eager",
  version: async () => store.hash(),
  materialize: (api: MountWriteAPI) => WorkerBundle({ version: store.hash(), files: store.files() }).materialize(api),
});

/**
 * Keeps and mounts `set` (run inside `blockConcurrencyWhile`, so it never throws). computer leaves a mount writable when
 * its copy fails, so the set held before is kept and mounted again, and when that fails too, the empty set (E1): the
 * mount is read-only again either way.
 */
export const mountWithFallback = async (store: Pick<SkillSetStore, "hash" | "files" | "replace">, remount: () => Promise<void>, set: SkillSet, warn: (message: string) => void): Promise<{ readonly error?: string }> => {
  const previous: SkillSet = { hash: store.hash(), files: store.files() };
  try {
    store.replace(set);
    await remount();
    return {};
  } catch (cause) {
    for (const fallback of [previous, EMPTY_SKILL_SET]) {
      try {
        store.replace(fallback);
        await remount();
        break;
      } catch (again) {
        warn(JSON.stringify({ t3flare: "skills-remount-failed", fallback: fallback.hash.slice(0, 12), error: String(again).slice(0, 300) }));
      }
    }
    return { error: `The Environment skill set could not be mounted, and the Workspace keeps the one it held: ${String(cause).slice(0, 300)}` };
  }
};
