// The workerd test Worker: the agents Worker's Durable Objects that need no Container or Worker Loader.
import { ContainerBudget } from "../src/budget.ts";

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
