// Reclaiming slots for a refused start (review F7, SPI-1149): idle holders are asked to stop only when enough of them
// are idle to bring the running count under the budget; otherwise none is, so a lowered budget stops nothing for nothing.
import { describe, expect, it } from "vitest";

import { reclaimFor } from "../src/workspace/reclaim.ts";

const holders = (idle: ReadonlyArray<string>) => {
  const released: Array<string> = [];
  return {
    released,
    deps: {
      idle: async (holder: string) => idle.includes(holder),
      release: async (holder: string) => {
        released.push(holder);
        return true;
      },
    },
  };
};

describe("reclaimFor", () => {
  it("at the budget, asks the first idle holder to stop, as before", async () => {
    const h = holders(["b"]);
    expect(await reclaimFor({ self: "me", running: ["a", "b"], max: 2, ...h.deps })).toEqual({ released: ["b"], enough: true });
    expect(h.released).toEqual(["b"]);
  });

  it("two running at a budget of 1, only one idle: asks none to stop, since one stop would not let the start through", async () => {
    const h = holders(["b"]);
    expect(await reclaimFor({ self: "me", running: ["a", "b"], max: 1, ...h.deps })).toEqual({ released: [], enough: false });
    expect(h.released).toEqual([]);
  });

  it("two running at a budget of 1, both idle: asks both to stop, which lets the start through", async () => {
    const h = holders(["a", "b"]);
    expect(await reclaimFor({ self: "me", running: ["a", "b"], max: 1, ...h.deps })).toEqual({ released: ["a", "b"], enough: true });
  });

  it("never counts or asks the starting Workspace itself", async () => {
    const h = holders(["me", "a"]);
    expect(await reclaimFor({ self: "me", running: ["me", "a", "b"], max: 2, ...h.deps })).toEqual({ released: ["a"], enough: true });
  });

  it("reports not enough when a holder found idle was no longer idle at its release", async () => {
    const released: Array<string> = [];
    const result = await reclaimFor({
      self: "me",
      running: ["a", "b"],
      max: 1,
      idle: async () => true,
      release: async (holder) => {
        if (holder === "b") return false;
        released.push(holder);
        return true;
      },
    });
    expect(result).toEqual({ released: ["a"], enough: false });
  });
});
