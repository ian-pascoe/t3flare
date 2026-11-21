// The Environment section's cost table (SPI-1149, ADR-0032): each Container size's resources and what an hour costs at
// worst, one Container and the Container budget's (the setting), every vCPU at full use, at Cloudflare's list prices for
// Containers on the Workers Paid plan (https://developers.cloudflare.com/containers/pricing/, 2026-10; checked against
// docs-archive-1:docs/steps/spi-1001-research-container-sizes.md §5): memory and disk are billed while a Container runs,
// CPU on active use only, so a real hour costs less. The plan's monthly allowance is the account's, so it is not taken off.
import { CONTAINER_SIZE_NAMES, CONTAINER_SIZES, type ContainerResources, type ContainerSize, DEFAULT_CONTAINER_SIZE } from "@t3flare/harness-registry";

/** US dollars per unit-second. */
const CONTAINER_PRICES = {
  /** Per GiB of provisioned memory, per second the Container runs. */
  memoryGibSecond: 0.0000025,
  /** Per vCPU, per second of active use. */
  vcpuSecond: 0.00002,
  /** Per GB of provisioned disk, per second the Container runs. */
  diskGbSecond: 0.00000007,
} as const;

export interface ContainerCostRow {
  readonly size: ContainerSize;
  readonly default: boolean;
  readonly resources: ContainerResources;
  /** US dollars for one Container's hour, every vCPU busy. */
  readonly perContainerHour: number;
  /** US dollars for an hour of the whole budget, each Container this size and busy. */
  readonly budgetHour: number;
}

export interface ContainerCostTable {
  readonly budget: number;
  readonly rows: ReadonlyArray<ContainerCostRow>;
}

const hourOf = ({ vcpu, memoryMib, diskMb }: ContainerResources): number =>
  3600 * (vcpu * CONTAINER_PRICES.vcpuSecond + (memoryMib / 1024) * CONTAINER_PRICES.memoryGibSecond + (diskMb / 1000) * CONTAINER_PRICES.diskGbSecond);

/** Every offered size, in the settings' order, priced for `budget` Containers at once. */
export const containerCostTable = (budget: number): ContainerCostTable => ({
  budget,
  rows: CONTAINER_SIZE_NAMES.map((size) => {
    const resources = CONTAINER_SIZES[size].resources;
    const perContainerHour = hourOf(resources);
    return { size, default: size === DEFAULT_CONTAINER_SIZE, resources, perContainerHour, budgetHour: perContainerHour * budget };
  }),
});
