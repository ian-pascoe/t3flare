// The Environment settings (SPI-1149, ADR-0032): what the Cloud Environment gives every Workspace and its Container,
// apart from the Harness settings (ADR-0026). Kept in the Environment DO under their own key and revision, so a change
// here never makes a Session take the Harness settings again. Edited in the Harness panel's Environment section; read by
// each Workspace DO before a Container start. Imported by both Workers.
//
// One schema (`ENVIRONMENT_SETTINGS`), one resolve (`resolveEnvironment`), one change (`applyEnvironmentChange`): a later
// setting (the Global mise config, SPI-1150; Variables, SPI-1152) adds an entry here and appears in the panel's section.
import { fieldProblem, type SettingEntry, type SettingValue } from "./fields.ts";

/**
 * The Container budget's default (step 2a cost guardrails): at most this many Containers run at once across the deploy.
 * The owner changes it in the Environment settings (`containerBudget`, 1 to 10: a cost guard, far under the account's
 * concurrent limits); each Workspace DO carries it with its lease request.
 */
export const DEFAULT_CONTAINER_BUDGET = 3;

/** The most the Container budget may be set to. */
export const MAX_CONTAINER_BUDGET = 10;

/** A Container's resources, as `ctx.container.start({ instance })` takes a custom size. */
export interface ContainerResources {
  readonly vcpu: number;
  /** Mebibytes. */
  readonly memoryMib: number;
  /** Megabytes. */
  readonly diskMb: number;
}

/** The named types the runtime accepts under `schedulingPolicy: "durable_object"` that t3flare offers. */
export type NamedContainerType = "standard-1" | "standard-2" | "standard-3" | "standard-4";

/** What a start passes as `instance`: a named type, or a custom size's resources. Never omitted (that starts `lite`). */
export type ContainerInstance = NamedContainerType | ContainerResources;

/**
 * The Container sizes, by the name kept in the settings, smallest memory first. `cpu-1` is t3flare's size before this
 * setting (cloudpid's `cpu-1`: 1 vCPU, 3 GiB, 12 GB), a custom size; the others are Cloudflare's named types, with the
 * resources its limits page gives (docs/steps/spi-1001-research-container-sizes.md §2). Not offered: `lite` and `basic`
 * (the runtime refuses `basic`), and cloudpid's other custom sizes. A stored name never changes meaning: adding a size
 * is free, removing one needs a rename map.
 */
export const CONTAINER_SIZES = {
  "cpu-1": { instance: { vcpu: 1, memoryMib: 3072, diskMb: 12_000 }, resources: { vcpu: 1, memoryMib: 3072, diskMb: 12_000 } },
  "standard-1": { instance: "standard-1", resources: { vcpu: 0.5, memoryMib: 4096, diskMb: 8_000 } },
  "standard-2": { instance: "standard-2", resources: { vcpu: 1, memoryMib: 6144, diskMb: 12_000 } },
  "standard-3": { instance: "standard-3", resources: { vcpu: 2, memoryMib: 8192, diskMb: 16_000 } },
  "standard-4": { instance: "standard-4", resources: { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 } },
} as const satisfies Readonly<Record<string, { readonly instance: ContainerInstance; readonly resources: ContainerResources }>>;

export type ContainerSize = keyof typeof CONTAINER_SIZES;

export const CONTAINER_SIZE_NAMES = Object.keys(CONTAINER_SIZES) as ReadonlyArray<ContainerSize>;

export const DEFAULT_CONTAINER_SIZE: ContainerSize = "cpu-1";

/** The size stored as `name`, or the default for a name t3flare does not offer. */
export const containerSizeOf = (name: unknown): ContainerSize =>
  typeof name === "string" && Object.hasOwn(CONTAINER_SIZES, name) ? (name as ContainerSize) : DEFAULT_CONTAINER_SIZE;

/** What `ctx.container.start({ instance })` takes for the stored size `name`: never undefined, the default for an unknown name. */
export const containerInstance = (name: unknown): ContainerInstance => CONTAINER_SIZES[containerSizeOf(name)].instance;

/** What the Environment DO stores (`t3flare:environment:settings`): the settings set explicitly. */
export interface StoredEnvironment {
  /** Bumped by every change; never moved by a Harness settings change (and the reverse). */
  readonly revision: number;
  readonly settings: Readonly<Record<string, SettingValue>>;
}

export const EMPTY_ENVIRONMENT: StoredEnvironment = { revision: 0, settings: {} };

/** What a Workspace DO reads: every setting resolved, a stored value that no longer fits read as its default. */
export interface ResolvedEnvironment {
  readonly revision: number;
  readonly containerSize: string;
  readonly containerIdleMinutes: number;
  readonly containerBudget: number;
}

/** The Environment settings' schema: the panel renders its section from it and the API validates against it. */
export const ENVIRONMENT_SETTINGS = {
  containerSize: {
    title: "Container size",
    description: "The vCPU, memory and disk a Workspace's Container starts with. Applies at each Workspace's next Container start; a running Container keeps its size.",
    schema: { type: "enum", values: CONTAINER_SIZE_NAMES, default: DEFAULT_CONTAINER_SIZE },
  },
  containerIdleMinutes: {
    title: "Idle time (minutes)",
    description: "A Container stops after this long without a command. Applies at each Workspace's next Container start.",
    schema: { type: "integer", minimum: 1, maximum: 60, default: 2 },
  },
  containerBudget: {
    title: "Container budget",
    description:
      "How many Containers may run at once across the Environment. Applies at the next start; lowering it stops no running Container, and new starts wait until fewer run.",
    schema: { type: "integer", minimum: 1, maximum: MAX_CONTAINER_BUDGET, default: DEFAULT_CONTAINER_BUDGET },
  },
} as const satisfies Readonly<Record<string, SettingEntry>>;

type EnvironmentKey = keyof typeof ENVIRONMENT_SETTINGS;

/** The stored `key`, or its default when it is missing or no longer fits the schema. */
const valueOf = (stored: StoredEnvironment, key: EnvironmentKey): SettingValue => {
  const entry: SettingEntry = ENVIRONMENT_SETTINGS[key];
  const value = stored.settings[key];
  return value !== undefined && fieldProblem(entry.schema, value) === undefined ? value : entry.schema.default;
};

/** The settings every Workspace DO starts its Container with. */
export const resolveEnvironment = (stored: StoredEnvironment): ResolvedEnvironment => ({
  revision: stored.revision,
  containerSize: valueOf(stored, "containerSize") as string,
  containerIdleMinutes: valueOf(stored, "containerIdleMinutes") as number,
  containerBudget: valueOf(stored, "containerBudget") as number,
});

/** One change from the panel or a script: some of the settings. */
export interface EnvironmentChange {
  readonly settings: Readonly<Record<string, unknown>>;
}

/** `stored` with `change` applied and the revision bumped, or why it is refused. */
export const applyEnvironmentChange = (
  stored: StoredEnvironment,
  change: EnvironmentChange,
): { readonly ok: true; readonly environment: StoredEnvironment } | { readonly ok: false; readonly error: string } => {
  const entries = Object.entries(change.settings);
  if (entries.length === 0) return { ok: false, error: "the change sets nothing" };
  for (const [key, value] of entries) {
    if (!Object.hasOwn(ENVIRONMENT_SETTINGS, key)) return { ok: false, error: `${key}: no such setting` };
    const why = fieldProblem(ENVIRONMENT_SETTINGS[key as EnvironmentKey].schema, value);
    if (why !== undefined) return { ok: false, error: `${key}: ${why}` };
  }
  return { ok: true, environment: { revision: stored.revision + 1, settings: { ...stored.settings, ...(change.settings as Record<string, SettingValue>) } } };
};
