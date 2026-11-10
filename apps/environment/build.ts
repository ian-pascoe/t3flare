// @effect-diagnostics globalConsole:off nodeBuiltinImport:off globalDate:off
// The environment Worker's build (ADR-0020): the only way it is bundled. alchemy uploads `dist/worker/`
// with `bundle: false` (alchemy.run.ts), because alchemy 2.0.0-beta.85 drops `build.input.plugins` on every
// update after the first deploy.
//
//   bun build.ts           bundle to dist/worker/ (and dist/build-report.json)
//   bun build.ts --check   only check that every Patch applies to the pinned t3code (`git apply --check`)
//
// Rolldown runs with the options alchemy's own Worker bundling uses (its Cloudflare plugin, minify,
// strictExecutionOrder, lazyBarrel, inlineConst), plus t3flare's changes to t3 (ADR-0001):
//
// - Patches (`patches/*.patch`, git diffs against the submodule), applied in memory: the submodule's
//   working tree stays untouched.
// - Build shims: the import-scoped `node:fs`/`node:module` alias of t3's own modules (ADR-0007), the
//   `node:sea` stub, generated stubs for dependencies that do forbidden work at module load, and
//   `import.meta` defines.
// - The module-state probe: registrations of t3's module-level mutable bindings, read by the twice-boot
//   check (src/host/moduleState.ts). Diagnostic only; it changes no behaviour.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { Plugin } from "rolldown";

const here = import.meta.dirname;
const shim = (name: string) => path.join(here, "src/shims", name);
const T3_ROOT = path.join(here, "../../t3code");
const PATCHES_DIR = path.join(here, "../../patches");

export const COMPATIBILITY = {
  date: "2026-11-01",
  flags: ["nodejs_compat"],
};

/** t3's own modules: its server and workspace packages, by real path. */
const T3_MODULE = /\/t3code\/(?:apps\/server|packages\/[^/]+)\/src\//;
const relativeToT3 = (id: string) => id.slice(id.indexOf("/t3code/") + "/t3code/".length);

const FS_ALIASES: Record<string, string> = {
  "node:fs": shim("node-fs.ts"),
  fs: shim("node-fs.ts"),
  "node:fs/promises": shim("node-fs-promises.ts"),
  "fs/promises": shim("node-fs-promises.ts"),
  // t3's module-scope createRequire of native packages (see the shim).
  "node:module": shim("node-module.ts"),
  module: shim("node-module.ts"),
};

/** Node builtins workerd lacks, replaced for every importer. */
const BUILTIN_STUBS: Record<string, string> = {
  "node:sea": shim("node-sea.ts"),
};

/**
 * Dependencies replaced by generated stubs: packages that do work the runtime forbids while their module
 * initializes, and that the DO never calls. Each stub exports the real package's names, as functions that
 * throw when called.
 */
const DEPENDENCY_STUBS: Record<string, string> = {
  // Generates a session id with randomUUID() at module scope; Claude runs in a Container (step 4).
  "@anthropic-ai/claude-agent-sdk": "Claude Code SDK: module-scope randomUUID()",
};

export interface BuildReport {
  readonly t3: string;
  readonly commit: string;
  readonly builtAt: string;
  readonly patches: ReadonlyArray<string>;
  readonly shadows: ReadonlyArray<string>;
  readonly buildShims: {
    readonly fsAlias: { readonly rewritten: number; readonly importers: number; readonly skippedDependencyImports: number };
    readonly builtinStubs: ReadonlyArray<string>;
    readonly dependencyStubs: ReadonlyArray<string>;
    readonly defines: ReadonlyArray<string>;
  };
  readonly moduleStateProbe: { readonly modules: number; readonly bindings: number };
  readonly bytes: number;
}

const git = (args: Array<string>, cwd: string) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() };
};

export const patchFiles = () =>
  fs.existsSync(PATCHES_DIR) ? fs.readdirSync(PATCHES_DIR).filter((f) => f.endsWith(".patch")).sort() : [];

/** `git apply --check` of every Patch against the submodule's pinned tree: what a bump validates first. */
export const checkPatches = (): Array<{ readonly patch: string; readonly ok: boolean; readonly detail: string }> =>
  patchFiles().map((file) => {
    const result = git(["apply", "--check", "--whitespace=nowarn", path.join(PATCHES_DIR, file)], T3_ROOT);
    return { patch: file, ok: result.ok, detail: result.out };
  });

const t3Version = () => git(["describe", "--tags", "--always"], T3_ROOT).out;
const ourCommit = () => git(["rev-parse", "--short=12", "HEAD"], here).out;

/** Patches applied in memory: `load` returns the patched text of each file a Patch touches. */
const patchedT3Modules = (applied: Array<string>): Plugin => {
  const patched = new Map<string, string>();
  return {
    name: "t3flare:t3-patches",
    buildStart() {
      patched.clear();
      applied.length = 0;
      const files = patchFiles();
      if (files.length === 0) return;
      for (const result of checkPatches()) {
        if (!result.ok) throw new Error(`t3flare: patch ${result.patch} does not apply to the pinned t3code:\n${result.detail}`);
      }
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "t3flare-patches-"));
      const touched = new Set<string>();
      for (const file of files) {
        const text = fs.readFileSync(path.join(PATCHES_DIR, file), "utf8");
        for (const match of text.matchAll(/^\+\+\+ b\/(.+)$/gm)) touched.add(match[1]!);
      }
      for (const relative of touched) {
        fs.mkdirSync(path.dirname(path.join(work, relative)), { recursive: true });
        fs.copyFileSync(path.join(T3_ROOT, relative), path.join(work, relative));
      }
      for (const file of files) {
        const result = git(["apply", "--whitespace=nowarn", path.join(PATCHES_DIR, file)], work);
        if (!result.ok) throw new Error(`t3flare: patch ${file} does not apply: ${result.out}`);
        applied.push(file);
      }
      for (const relative of touched) {
        patched.set(fs.realpathSync(path.join(T3_ROOT, relative)), fs.readFileSync(path.join(work, relative), "utf8"));
      }
      fs.rmSync(work, { recursive: true, force: true });
    },
    load(id) {
      return patched.get(id) ?? null;
    },
  };
};

// Static imports and re-exports (`import … from`, `} from` closing a multi-line import, `export … from`) and
// dynamic `import()`; anchored to line starts so that module source t3 embeds in strings (scripts it runs
// over SSH or in workers) is left alone.
const IMPORT_SPECIFIER = /(^\s*(?:import|export|\})[^\n]*?\bfrom\s*|\bawait import\s*\(\s*)(["'])([^"']+)\2/gm;

/**
 * The import-scoped builtin alias (ADR-0007), as a `transform` of t3's own modules: Cloudflare's Rolldown
 * plugin claims `node:*` builtins in a "pre" resolveId hook, so a resolveId alias never sees them.
 */
const t3NodeFsAlias = (report: { rewritten: number; importers: Set<string>; skippedDependencyImports: number }): Plugin => ({
  name: "t3flare:t3-node-fs",
  buildStart() {
    report.rewritten = 0;
    report.skippedDependencyImports = 0;
    report.importers.clear();
  },
  transform(code, id) {
    if (!T3_MODULE.test(id)) {
      if (/["']node:fs["']/.test(code)) report.skippedDependencyImports++;
      return null;
    }
    let count = 0;
    const next = code.replace(IMPORT_SPECIFIER, (match, lead: string, quote: string, specifier: string) => {
      const target = FS_ALIASES[specifier];
      if (target === undefined) return match;
      count++;
      return `${lead}${quote}${target}${quote}`;
    });
    if (count === 0) return null;
    report.rewritten += count;
    report.importers.add(relativeToT3(id));
    return { code: next, map: null };
  },
});

const STUB_PREFIX = "\0t3flare-stub:";
const T3_SERVER_PACKAGE = path.join(T3_ROOT, "apps/server/package.json");

const dependencyStubs = (): Plugin => ({
  name: "t3flare:dependency-stubs",
  resolveId(source) {
    const name = Object.keys(DEPENDENCY_STUBS).find((pkg) => source === pkg || source.startsWith(`${pkg}/`));
    return name === undefined ? null : { id: `${STUB_PREFIX}${source}`, moduleSideEffects: false };
  },
  async load(id) {
    if (!id.startsWith(STUB_PREFIX)) return null;
    const source = id.slice(STUB_PREFIX.length);
    let names: Array<string> = [];
    try {
      const resolved = createRequire(T3_SERVER_PACKAGE).resolve(source);
      names = Object.keys(await import(resolved)).filter((name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name));
    } catch {
      names = [];
    }
    return [
      `const stub = (name) => function () { throw new Error("t3flare: " + name + " is not available in the Environment DO"); };`,
      ...names.map((name) => `export const ${name} = stub(${JSON.stringify(`${source}.${name}`)});`),
      `export default {};`,
    ].join("\n");
  },
});

type AstNode = { type: string; [key: string]: unknown };

/** Whether a top-level `const` initializer is a mutable container. */
const isMutableContainer = (init: AstNode | null | undefined): boolean => {
  if (init == null) return false;
  if (init.type === "NewExpression") {
    const callee = init.callee as AstNode;
    return callee.type === "Identifier" && ["Map", "Set", "WeakMap", "WeakSet", "Array"].includes(callee.name as string);
  }
  if (init.type === "ArrayExpression") return (init.elements as Array<unknown>).length === 0;
  if (init.type === "ObjectExpression") return (init.properties as Array<unknown>).length === 0;
  return false;
};

/** The module-state probe: appends a registration of t3's module-level mutable bindings to each t3 module. */
const moduleStateProbe = (report: { modules: number; bindings: number }): Plugin => {
  let parseAst: ((code: string, options: { lang: "ts" | "tsx" | "js" }, filename: string) => { body: Array<AstNode> }) | undefined;
  return {
    name: "t3flare:module-state-probe",
    async buildStart() {
      report.modules = 0;
      report.bindings = 0;
      parseAst = ((await import("rolldown/parseAst")) as unknown as { parseAst: typeof parseAst }).parseAst;
    },
    transform(code, id) {
      if (!T3_MODULE.test(id) || !/\.(?:ts|tsx|js|mjs)$/.test(id) || parseAst === undefined) return null;
      let body: Array<AstNode>;
      try {
        body = parseAst(code, { lang: id.endsWith(".tsx") ? "tsx" : id.endsWith(".ts") ? "ts" : "js" }, id).body;
      } catch {
        return null;
      }
      const names: Array<string> = [];
      for (const statement of body) {
        const declaration = (statement.type === "ExportNamedDeclaration" ? statement.declaration : statement) as AstNode | null;
        if (declaration?.type !== "VariableDeclaration" || declaration.declare === true) continue;
        for (const declarator of declaration.declarations as Array<AstNode>) {
          const binding = declarator.id as AstNode;
          if (binding.type !== "Identifier") continue;
          if (declaration.kind === "let" || declaration.kind === "var" || isMutableContainer(declarator.init as AstNode | null)) {
            names.push(binding.name as string);
          }
        }
      }
      if (names.length === 0) return null;
      report.modules++;
      report.bindings += names.length;
      const getters = names.map((name) => `${JSON.stringify(name)}: () => ${name}`).join(", ");
      return {
        code: `${code}\n;globalThis.__t3flareModuleState?.register(${JSON.stringify(relativeToT3(id))}, { ${getters} });\n`,
        map: null,
      };
    },
  };
};

const DEFINES = {
  // workerd leaves `import.meta.url` undefined, and Node-style packages call createRequire(import.meta.url)
  // at module scope.
  "import.meta.url": JSON.stringify("file:///bundle/worker.js"),
  "import.meta.dirname": JSON.stringify("/bundle"),
  "import.meta.filename": JSON.stringify("/bundle/worker.js"),
};

/** Bundles the Worker to `dist/worker/`, as alchemy would, and writes `dist/build-report.json`. */
export const buildWorker = async (options: { readonly quiet?: boolean } = {}): Promise<BuildReport> => {
  const { rolldown } = await import("rolldown");
  const { default: cloudflare } = await import("@alchemy.run/cloudflare-runtime/rolldown");
  const fsAlias = { rewritten: 0, importers: new Set<string>(), skippedDependencyImports: 0 };
  const probe = { modules: 0, bindings: 0 };
  const applied: Array<string> = [];
  const identity = { t3: t3Version(), commit: ourCommit(), builtAt: new Date().toISOString() };
  const bundle = await rolldown({
    input: path.join(here, "src/worker.ts"),
    cwd: here,
    external: ["lightningcss", "fsevents", "cloudflare:workers"],
    plugins: [
      patchedT3Modules(applied),
      t3NodeFsAlias(fsAlias),
      dependencyStubs(),
      moduleStateProbe(probe),
      cloudflare({ compatibilityDate: COMPATIBILITY.date, compatibilityFlags: COMPATIBILITY.flags }),
    ],
    resolve: { alias: BUILTIN_STUBS },
    transform: { define: { ...DEFINES, __T3FLARE_BUILD__: JSON.stringify(identity) } },
    checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
    experimental: { lazyBarrel: true },
    optimization: { inlineConst: { mode: "smart", pass: 3 } },
  });
  fs.rmSync(path.join(here, "dist/worker"), { recursive: true, force: true });
  const out = await bundle.write({
    dir: path.join(here, "dist/worker"),
    format: "esm",
    sourcemap: "hidden",
    minify: true,
    keepNames: true,
    strictExecutionOrder: true,
  });
  await bundle.close();
  let bytes = 0;
  for (const chunk of out.output) {
    if (chunk.fileName.endsWith(".map")) continue;
    bytes += chunk.type === "chunk" ? Buffer.byteLength(chunk.code) : Buffer.byteLength(chunk.source);
  }
  const report: BuildReport = {
    ...identity,
    patches: applied,
    shadows: [],
    buildShims: {
      fsAlias: { rewritten: fsAlias.rewritten, importers: fsAlias.importers.size, skippedDependencyImports: fsAlias.skippedDependencyImports },
      builtinStubs: Object.keys(BUILTIN_STUBS),
      dependencyStubs: Object.keys(DEPENDENCY_STUBS),
      defines: Object.keys(DEFINES),
    },
    moduleStateProbe: probe,
    bytes,
  };
  fs.writeFileSync(path.join(here, "dist/build-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet) {
    console.log(
      `t3flare: built ${(bytes / 1024 / 1024).toFixed(2)} MiB for t3 ${report.t3}; ${applied.length} patches, ` +
        `${fsAlias.rewritten} node:fs imports aliased in ${fsAlias.importers.size} t3 modules, ` +
        `module-state probe in ${probe.modules} modules (${probe.bindings} bindings)`,
    );
  }
  return report;
};

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const results = checkPatches();
    for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.patch}${result.ok ? "" : `\n${result.detail}`}`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
  const started = performance.now();
  await buildWorker();
  console.log(`t3flare: build took ${((performance.now() - started) / 1000).toFixed(1)} s`);
}
