// The workerd test Worker: the agents Worker's Durable Objects that need no Container or Worker Loader, and a probe of
// computer's VFS tables.
import { Workspace } from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";

import { ContainerBudget } from "../src/budget.ts";
import { largestFileUnder } from "../src/workspace/changeLog.ts";

export { ContainerBudget };

/** A ContainerBudget on a clock that only `advance` moves, so lease timing never depends on how loaded the machine is. */
export class FakeClockContainerBudget extends ContainerBudget {
  #clock = 1_000_000;
  protected override readonly now = () => this.#clock;

  advance(ms: number): void {
    this.#clock += ms;
  }
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

  async largest(dir: string): Promise<number> {
    await this.#workspace.ready();
    return largestFileUnder(this.ctx.storage.sql, dir);
  }
}
