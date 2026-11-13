// The Environment section's cost table (SPI-1149): each Container size's resources and the worst-case hourly cost of the
// Container budget's three Containers, all at full CPU, at Cloudflare's Workers Paid list prices (the vendored
// `@cloudpid/config` prices). Expected figures are the research's worked example (docs/steps/spi-1001-research-
// container-sizes.md §5: a standard-4 hour at full CPU is $0.288 CPU + $0.108 memory + $0.00504 disk), worked by hand for
// the others.
import { describe, expect, it } from "vitest";

import { containerCostTable } from "../src/harness/containerCost.ts";

describe("containerCostTable", () => {
  const table = containerCostTable();
  const row = (size: string) => table.rows.find((entry) => entry.size === size)!;

  it("lists the five offered sizes with their resources, the default first", () => {
    expect(table.budget).toBe(3);
    expect(table.rows.map((entry) => [entry.size, entry.resources, entry.default])).toEqual([
      ["cpu-1", { vcpu: 1, memoryMib: 3072, diskMb: 12000 }, true],
      ["standard-1", { vcpu: 0.5, memoryMib: 4096, diskMb: 8000 }, false],
      ["standard-2", { vcpu: 1, memoryMib: 6144, diskMb: 12000 }, false],
      ["standard-3", { vcpu: 2, memoryMib: 8192, diskMb: 16000 }, false],
      ["standard-4", { vcpu: 4, memoryMib: 12288, diskMb: 20000 }, false],
    ]);
  });

  it("prices one standard-4 hour at full CPU as the research does, and the budget's three at three times that", () => {
    expect(row("standard-4").perContainerHour).toBeCloseTo(0.40104, 6);
    expect(row("standard-4").budgetHour).toBeCloseTo(1.20312, 6);
  });

  it("prices the default cpu-1: $0.072 CPU, $0.027 memory and $0.003024 disk an hour", () => {
    expect(row("cpu-1").perContainerHour).toBeCloseTo(0.102024, 6);
    expect(row("cpu-1").budgetHour).toBeCloseTo(0.306072, 6);
  });

  it("prices standard-1 at half a vCPU: $0.036 CPU, $0.036 memory and $0.002016 disk an hour", () => {
    expect(row("standard-1").perContainerHour).toBeCloseTo(0.074016, 6);
  });
});
