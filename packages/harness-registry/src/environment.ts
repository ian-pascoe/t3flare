// The Environment settings (SPI-1149, ADR-0032): what the Cloud Environment gives every Workspace and its Container,
// apart from the Harness settings (ADR-0026). Kept in the Environment DO under their own key and revision, so a change
// here never makes a Session take the Harness settings again. Edited in the Harness panel's Environment section; read by
// each Workspace DO before a Container start. Imported by both Workers.
//
// One schema (`ENVIRONMENT_SETTINGS`), one resolve (`resolveEnvironment`), one change (`applyEnvironmentChange`): a later
// setting (the Global mise config, SPI-1150; Variables, SPI-1152) is one entry in `ENVIRONMENT_SETTINGS`. The resolved
// type, the resolve, the validation and the panel's section all follow from it.
import { type EnvironmentSettingEntry, type EnvironmentValue, fieldProblem } from "./fields.ts";
import { fitVariables, MAX_VARIABLES } from "./variables.ts";

export * from "./variables.ts";

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
 * setting (cloudpid's `cpu-1`: 1 vCPU, 3 GiB, 12 GB), a custom size started as its resources; the others are Cloudflare's
 * named types, started by name, with the resources its limits page gives
 * (docs/steps/spi-1001-research-container-sizes.md §2). Not offered: `lite` and `basic` (the runtime refuses `basic`),
 * and cloudpid's other custom sizes. A stored name never changes meaning: adding a size is free, removing one needs a
 * rename map.
 */
export const CONTAINER_SIZES = {
  "cpu-1": { custom: true, resources: { vcpu: 1, memoryMib: 3072, diskMb: 12_000 } },
  "standard-1": { custom: false, resources: { vcpu: 0.5, memoryMib: 4096, diskMb: 8_000 } },
  "standard-2": { custom: false, resources: { vcpu: 1, memoryMib: 6144, diskMb: 12_000 } },
  "standard-3": { custom: false, resources: { vcpu: 2, memoryMib: 8192, diskMb: 16_000 } },
  "standard-4": { custom: false, resources: { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 } },
} as const satisfies Readonly<Record<string, { readonly custom: boolean; readonly resources: ContainerResources }>>;

export type ContainerSize = keyof typeof CONTAINER_SIZES;

export const CONTAINER_SIZE_NAMES = Object.keys(CONTAINER_SIZES) as ReadonlyArray<ContainerSize>;

export const DEFAULT_CONTAINER_SIZE: ContainerSize = "cpu-1";

/**
 * What `ctx.container.start({ instance })` takes for `size`: a custom size's resources, a named type's name. Never
 * undefined (an omitted `instance` starts `lite`); a stored name t3flare does not offer resolves to the default first
 * (`resolveEnvironment`).
 */
export const containerInstance = (size: ContainerSize): ContainerInstance => {
  const entry = CONTAINER_SIZES[size];
  return entry.custom ? entry.resources : (size as NamedContainerType);
};

/** What the Environment DO stores (`t3flare:environment:settings`): the settings set explicitly. */
export interface StoredEnvironment {
  /** Bumped by every change; never moved by a Harness settings change (and the reverse). */
  readonly revision: number;
  readonly settings: Readonly<Record<string, EnvironmentValue>>;
}

export const EMPTY_ENVIRONMENT: StoredEnvironment = { revision: 0, settings: {} };

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
  variables: {
    title: "Variables",
    description: `Plain NAME=value pairs every command in a Workspace starts with: agents' commands, Terminals and CLI agents. Agents can read them, so never a secret. Anything t3flare, t3, mise's [env] or the command itself sets wins over them. At most ${MAX_VARIABLES}. Applies at each Workspace's next Container start.`,
    schema: { type: "variables", default: {} },
  },
} as const satisfies Readonly<Record<string, EnvironmentSettingEntry>>;

export type EnvironmentKey = keyof typeof ENVIRONMENT_SETTINGS;

const ENVIRONMENT_KEYS = Object.keys(ENVIRONMENT_SETTINGS) as ReadonlyArray<EnvironmentKey>;

/** The value a field of `schema` holds: an enum's own names, a number, a boolean or text. */
type ValueOf<Schema> = Schema extends { readonly type: "enum"; readonly values: ReadonlyArray<infer Name> }
  ? Name
  : Schema extends { readonly type: "integer" }
    ? number
    : Schema extends { readonly type: "boolean" }
      ? boolean
      : Schema extends { readonly type: "variables" }
        ? Readonly<Record<string, string>>
        : string;

/** What a Workspace DO reads: every setting resolved, a stored value that no longer fits read as its default. */
export type ResolvedEnvironment = { readonly revision: number } & {
  readonly [Key in EnvironmentKey]: ValueOf<(typeof ENVIRONMENT_SETTINGS)[Key]["schema"]>;
};

/** Whether `value` fits setting `key`'s schema. */
export const fitsEnvironmentSetting = (key: EnvironmentKey, value: unknown): boolean =>
  fieldProblem((ENVIRONMENT_SETTINGS[key] as EnvironmentSettingEntry).schema, value) === undefined;

/**
 * The settings every Workspace DO starts its Container with. `settings` is what was stored, or an answer from an
 * Environment newer or older than this Worker: a value that is missing or no longer fits reads as its default.
 */
export const resolveEnvironment = (stored: { readonly revision: number; readonly settings: Readonly<Record<string, unknown>> }): ResolvedEnvironment => {
  const resolved: Record<string, unknown> = { revision: stored.revision };
  for (const key of ENVIRONMENT_KEYS) {
    const value = stored.settings[key];
    const schema = (ENVIRONMENT_SETTINGS[key] as EnvironmentSettingEntry).schema;
    // Variables: one a later rule refuses is dropped alone, never the whole set (ADR-0032's Variables refinement).
    if (schema.type === "variables") resolved[key] = fitVariables(value);
    else resolved[key] = value !== undefined && fitsEnvironmentSetting(key, value) ? value : schema.default;
  }
  // SAFETY: every key of the schema was set above, each to a value its schema accepts.
  return resolved as ResolvedEnvironment;
};

/** Whether two settings' values are equal: a scalar by identity, Variables by their names and values in order. */
const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || (typeof a === "object" && a !== null && typeof b === "object" && b !== null && JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b)));

/** One change from the panel or a script: some of the settings. */
export interface EnvironmentChange {
  readonly settings: Readonly<Record<string, unknown>>;
}

/**
 * `stored` with `change` applied, or why it is refused. `changed` names the settings whose resolved value moved; only
 * they are stored and the revision is bumped only when there is one (a form posts every setting on each save).
 */
export const applyEnvironmentChange = (
  stored: StoredEnvironment,
  change: EnvironmentChange,
): { readonly ok: true; readonly environment: StoredEnvironment; readonly changed: ReadonlyArray<EnvironmentKey> } | { readonly ok: false; readonly error: string } => {
  const entries = Object.entries(change.settings);
  if (entries.length === 0) return { ok: false, error: "the change sets nothing" };
  for (const [key, value] of entries) {
    if (!Object.hasOwn(ENVIRONMENT_SETTINGS, key)) return { ok: false, error: `${key}: no such setting` };
    const why = fieldProblem((ENVIRONMENT_SETTINGS[key as EnvironmentKey] as EnvironmentSettingEntry).schema, value);
    if (why !== undefined) return { ok: false, error: `${key}: ${why}` };
  }
  const before: Readonly<Record<string, unknown>> = resolveEnvironment(stored);
  const moved = entries.filter(([key, value]) => !sameValue(before[key], value));
  if (moved.length === 0) return { ok: true, environment: stored, changed: [] };
  return {
    ok: true,
    environment: { revision: stored.revision + 1, settings: { ...stored.settings, ...(Object.fromEntries(moved) as Record<string, EnvironmentValue>) } },
    changed: moved.map(([key]) => key as EnvironmentKey),
  };
};
