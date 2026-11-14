// The workerd test Worker: the agents Worker's Durable Objects that need no Container or Worker Loader, and a probe of
// computer's VFS tables.
import { Workspace } from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";

import { ContainerBudget } from "../src/budget.ts";
import { SKILLS_MOUNT, type SkillSet } from "@t3flare/skills";

import { repoFileSizes } from "../src/workspace/changeLog.ts";
import { mountWithFallback, skillSetMount, skillSetStore } from "../src/workspace/skillSet.ts";

export { ContainerBudget };

/** A ContainerBudget on a clock that only `advance` moves, so lease timing never depends on how loaded the machine is. */
export class FakeClockContainerBudget extends ContainerBudget {
  #clock = 1_000_000;
  protected override readonly now = () => this.#clock;

  advance(ms: number): void {
    this.#clock += ms;
  }
}

/** The fake-clock budget as a deploy runs it: no `T3FLARE_MAX_CONTAINERS`, so the budget carried with a request judges it. */
export class SettingContainerBudget extends FakeClockContainerBudget {
  protected override readonly maxOverride = () => undefined;
}

export default { fetch: () => new Response("t3flare agents test worker") };

/** A computer Workspace with no backends, over this object's SQLite: the VFS tables as the Workspace DO has them. */
export class VfsProbe extends DurableObject {
  readonly #workspace = new Workspace({ storage: this.ctx.storage, backends: [] });

  async write(path: string, bytes: number): Promise<void> {
    await this.#workspace.ready();
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await this.#workspace.fs.writeFile(path, new Uint8Array(bytes).fill(7));
  }

  async remove(path: string): Promise<void> {
    await this.#workspace.ready();
    await this.#workspace.fs.rm(path);
  }

  async symlink(target: string, path: string): Promise<void> {
    await this.#workspace.ready();
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await this.#workspace.fs.symlink(target, path);
  }

  async sizes(dir: string): Promise<{ largest: number; worktreeBytes: number }> {
    await this.#workspace.ready();
    return repoFileSizes(this.ctx.storage.sql, dir);
  }
}

/**
 * The Workspace DO's Environment skill set (SPI-1148) over a real computer Workspace: the store, the read-only mount and
 * the take with its fallback. A set holding `boom/SKILL.md` fails its copy, as a write computer cannot make would.
 */
export class SkillSetProbe extends DurableObject {
  readonly #store = skillSetStore({ kv: this.ctx.storage.kv, transactionSync: (closure) => this.ctx.storage.transactionSync(closure) });
  readonly #mount = skillSetMount(this.#store);
  readonly #workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [],
    mounts: {
      [SKILLS_MOUNT]: { ...this.#mount, materialize: (api) => (this.#store.files()["boom/SKILL.md"] === undefined ? this.#mount.materialize(api) : Promise.reject(new Error("boom"))) },
    },
  });

  async take(set: SkillSet): Promise<{ readonly error?: string; readonly hash: string }> {
    await this.#workspace.ready();
    const answer = await this.ctx.blockConcurrencyWhile(() => mountWithFallback(this.#store, () => this.#workspace.remount(), set, () => undefined));
    return { ...answer, hash: this.#store.hash() };
  }

  async listing() {
    return this.#store.listing();
  }

  async read(path: string): Promise<string | null> {
    await this.#workspace.ready();
    return this.#workspace.fs.readFile(path, "utf8").catch(() => null);
  }

  async write(path: string): Promise<string> {
    await this.#workspace.ready();
    return this.#workspace.fs.writeFile(path, "x").then(
      () => "written",
      (error: unknown) => String(error),
    );
  }

  async find(): Promise<ReadonlyArray<string>> {
    await this.#workspace.ready();
    return (await this.#workspace.fs.find(SKILLS_MOUNT).catch(() => [])).map((entry) => entry.path).sort();
  }
}
