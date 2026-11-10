// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// The environment Worker's bundler options, shared by the deploy (alchemy's
// `build.input`, alchemy.run.ts) and a local build with the same Rolldown settings for
// measuring the bundle (`bun build.ts`).
//
// - The import-scoped `node:fs` alias (ADR-0007): only imports made by t3's own modules
//   go to our State-directory shim; dependencies keep workerd's `node:fs`.
// - Dependency stubs: native or host-only packages t3 imports but the DO never calls.
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { Plugin } from "rolldown";

const here = import.meta.dirname;
const shim = (name: string) => path.join(here, "src/shims", name);

/** t3's own modules: its server and workspace packages, by real path. */
const T3_MODULE = /\/t3code\/(?:apps\/server|packages\/[^/]+)\/src\//;

const FS_ALIASES: Record<string, string> = {
  "node:fs": shim("node-fs.ts"),
  fs: shim("node-fs.ts"),
  "node:fs/promises": shim("node-fs-promises.ts"),
  "fs/promises": shim("node-fs-promises.ts"),
  // t3's module-scope createRequire of native packages (see the shim).
  "node:module": shim("node-module.ts"),
  module: shim("node-module.ts"),
};

export const fsAliasReport = { rewritten: 0, importers: new Set<string>(), skippedDependencyImports: 0 };

// Static imports and re-exports (`import … from`, `} from` closing a multi-line import,
// `export … from`) and dynamic `import()`; anchored to line starts so that module source
// t3 embeds in strings (scripts it runs over SSH or in workers) is left alone.
const IMPORT_SPECIFIER = /(^\s*(?:import|export|\})[^\n]*?\bfrom\s*|\bawait import\s*\(\s*)(["'])([^"']+)\2/gm;

export const t3NodeFsAlias = (): Plugin => ({
  name: "t3flare:t3-node-fs",
  // The alias is a transform of t3's own modules, not a resolveId hook: Cloudflare's
  // plugin claims `node:*` builtins in a "pre" resolveId hook, and alchemy's plan copies
  // plugin objects so that a nested `{ order, handler }` hook loses its handler (the
  // second build of a deploy failed with "handler.call"). Top-level hook functions survive.
  transform(code, id) {
    if (!T3_MODULE.test(id)) {
      if (/["']node:fs["']/.test(code)) fsAliasReport.skippedDependencyImports++;
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
    fsAliasReport.rewritten += count;
    fsAliasReport.importers.add(id.slice(id.indexOf("/t3code/") + 1));
    return { code: next, map: null };
  },
  buildStart() {
    fsAliasReport.rewritten = 0;
    fsAliasReport.skippedDependencyImports = 0;
    fsAliasReport.importers.clear();
  },
  buildEnd() {
    const report = {
      rewritten: fsAliasReport.rewritten,
      skippedDependencyImports: fsAliasReport.skippedDependencyImports,
      importers: [...fsAliasReport.importers].sort(),
    };
    fs.mkdirSync(path.join(here, "dist"), { recursive: true });
    fs.writeFileSync(path.join(here, "dist/fs-alias-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`t3flare: node:fs alias rewrote ${report.rewritten} imports in ${report.importers.length} t3 modules`);
  },
});

/**
 * Dependencies replaced by generated stubs: packages that do host-only work (or work the
 * runtime forbids, like randomness) while their module initializes, and that the DO never
 * calls. Each stub exports the real package's names, as functions that throw when called.
 */
export const DEPENDENCY_STUBS: Record<string, string> = {
  // Generates a session id with randomUUID() at module scope; Claude runs in a Container (step 4).
  "@anthropic-ai/claude-agent-sdk": "Claude Code SDK: module-scope randomUUID()",
};

const STUB_PREFIX = "\0t3flare-stub:";
const T3_SERVER = path.join(here, "../../t3code/apps/server/package.json");

export const dependencyStubs = (): Plugin => ({
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
      const resolved = createRequire(T3_SERVER).resolve(source);
      names = Object.keys(await import(resolved)).filter((name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name));
    } catch {
      names = [];
    }
    const lines = [
      `const stub = (name) => { const f = function () { throw new Error("t3flare: " + name + " is not available in the Environment DO"); }; return f; };`,
      ...names.map((name) => `export const ${name} = stub(${JSON.stringify(`${source}.${name}`)});`),
      `export default {};`,
    ];
    return lines.join("\n");
  },
});

/** Node builtins workerd lacks, replaced for every importer. */
export const BUILTIN_STUBS: Record<string, string> = {
  "node:sea": shim("node-sea.ts"),
};

const stubAliases = { ...BUILTIN_STUBS };

/**
 * Patches (ADR-0001, last resort): `patches/*.patch` at the repo root, git diffs against
 * the t3code submodule. Applied in memory while bundling, so the submodule's working
 * tree stays untouched; `git apply --check` from t3code/ validates them on a bump.
 */
const T3_ROOT = path.join(here, "../../t3code");
const PATCHES_DIR = path.join(here, "../../patches");

export const patchedT3Modules = (): Plugin => {
  const patched = new Map<string, string>();
  return {
    name: "t3flare:t3-patches",
    buildStart() {
      patched.clear();
      const files = fs.existsSync(PATCHES_DIR) ? fs.readdirSync(PATCHES_DIR).filter((f) => f.endsWith(".patch")).sort() : [];
      if (files.length === 0) return;
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
        const result = spawnSync("git", ["apply", "--whitespace=nowarn", path.join(PATCHES_DIR, file)], { cwd: work });
        if (result.status !== 0) throw new Error(`t3flare: patch ${file} does not apply: ${result.stderr.toString()}`);
      }
      for (const relative of touched) {
        patched.set(fs.realpathSync(path.join(T3_ROOT, relative)), fs.readFileSync(path.join(work, relative), "utf8"));
      }
      fs.rmSync(work, { recursive: true, force: true });
      console.log(`t3flare: ${files.length} patches applied to ${touched.size} t3 modules`);
    },
    load(id) {
      return patched.get(id) ?? null;
    },
  };
};

export const workerBuild = {
  input: {
    plugins: [patchedT3Modules(), t3NodeFsAlias(), dependencyStubs()],
    resolve: { alias: stubAliases },
    // workerd leaves `import.meta.url` undefined, and Node-style packages call
    // `createRequire(import.meta.url)` at module scope.
    transform: {
      define: {
        "import.meta.url": JSON.stringify("file:///bundle/worker.js"),
        "import.meta.dirname": JSON.stringify("/bundle"),
        "import.meta.filename": JSON.stringify("/bundle/worker.js"),
      },
    },
  },
};

export const COMPATIBILITY = {
  date: "2026-11-01",
  flags: ["nodejs_compat"],
};

// `bun build.ts`: bundle as alchemy does (Sources/Rolldown.ts in @alchemy.run/cloudflare).
if (import.meta.main) {
  const { rolldown } = await import("rolldown");
  const { default: cloudflare } = await import("@alchemy.run/cloudflare-runtime/rolldown");
  const started = performance.now();
  const bundle = await rolldown({
    input: path.join(here, "src/worker.ts"),
    cwd: here,
    external: ["lightningcss", "fsevents", "cloudflare:workers"],
    ...workerBuild.input,
    plugins: [
      workerBuild.input.plugins,
      cloudflare({ compatibilityDate: COMPATIBILITY.date, compatibilityFlags: COMPATIBILITY.flags }),
    ],
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
  let total = 0;
  for (const chunk of out.output) {
    const size = chunk.type === "chunk" ? Buffer.byteLength(chunk.code) : Buffer.byteLength(chunk.source);
    if (!chunk.fileName.endsWith(".map")) total += size;
    console.log(`${chunk.fileName}\t${(size / 1024 / 1024).toFixed(2)} MiB`);
  }
  console.log(`total (excl. maps): ${(total / 1024 / 1024).toFixed(2)} MiB in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}
