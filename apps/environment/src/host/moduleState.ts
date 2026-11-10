// Module-level state in t3 that outlives an Environment reset (ADR-0003).
//
// `ctx.abort()` resets the Environment DO, but a warm isolate keeps its evaluated modules, so any t3
// module-level mutable value survives into the next boot (Node never shows t3 this: a restarted process
// starts empty). The build (build.ts, `moduleStateProbe`) appends to each t3 module a registration of its
// top-level `let`/`var` bindings and its top-level `Map`/`Set`/empty-array/empty-object constants. This
// registry summarises each at registration and again on demand; the twice-boot check (admin route
// `/_t3flare/check/reboot`) reports the ones that differ from their initial summary after a second boot in
// the same isolate.

type Getters = Record<string, () => unknown>;

interface Binding {
  readonly module: string;
  readonly name: string;
  readonly get: () => unknown;
  readonly initial: string;
}

/** A short, comparable summary of a value: sizes for collections, the value itself for primitives. */
export const summarize = (value: unknown): string => {
  try {
    if (value === null || value === undefined) return String(value);
    if (value instanceof Map) return `Map(${value.size})`;
    if (value instanceof Set) return `Set(${value.size})`;
    if (value instanceof WeakMap || value instanceof WeakSet) return "Weak";
    if (Array.isArray(value)) return `Array(${value.length})`;
    if (typeof value === "function") return `fn ${value.name}`;
    if (typeof value === "object") {
      if (value instanceof Promise) return "Promise";
      return `Object{${Object.keys(value).sort().join(",").slice(0, 200)}}`;
    }
    return `${typeof value}:${String(value).slice(0, 120)}`;
  } catch {
    return "unreadable";
  }
};

const bindings: Array<Binding> = [];

interface Registry {
  register(module: string, getters: Getters): void;
}

const registry: Registry = {
  register(module, getters) {
    for (const [name, get] of Object.entries(getters)) {
      let initial: string;
      try {
        initial = summarize(get());
      } catch {
        initial = "uninitialized";
      }
      bindings.push({ module, name, get, initial });
    }
  },
};

/** The global the build's appended registrations call. Installed by the Worker's global scope. */
export const install = () => {
  (globalThis as { __t3flareModuleState?: Registry }).__t3flareModuleState = registry;
};

export interface ChangedBinding {
  readonly module: string;
  readonly name: string;
  readonly initial: string;
  readonly now: string;
}

/** The registered bindings whose value no longer matches its summary at module evaluation. */
export const changedSinceEvaluation = (): Array<ChangedBinding> =>
  bindings.flatMap((binding) => {
    let now: string;
    try {
      now = summarize(binding.get());
    } catch {
      now = "unreadable";
    }
    return now === binding.initial ? [] : [{ module: binding.module, name: binding.name, initial: binding.initial, now }];
  });

export const registeredCount = () => ({ bindings: bindings.length, modules: new Set(bindings.map((b) => b.module)).size });

/** Own and symbol keys on globalThis, to spot state t3 or its dependencies park there. */
export const globalKeys = (): Array<string> => [
  ...Object.getOwnPropertyNames(globalThis),
  ...Object.getOwnPropertySymbols(globalThis).map((symbol) => symbol.toString()),
];
