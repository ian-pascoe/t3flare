// @effect-diagnostics globalConsole:off nodeBuiltinImport:off globalDate:off
// The agents Worker's build (ADR-0020): bundled here with the Rolldown options alchemy's Worker bundling uses (its
// Cloudflare plugin, minify, strictExecutionOrder, lazyBarrel, inlineConst), and uploaded with `bundle: false`.
// Unlike the environment Worker it needs no Patch, Shadow or Build shim: it imports nothing of t3.
//
//   node build.ts      bundle to dist/worker/ and write dist/build-report.json
import * as fs from "node:fs";
import * as path from "node:path";

const here = import.meta.dirname;

export const COMPATIBILITY = {
  date: "2026-11-01",
  flags: ["nodejs_compat", "nodejs_compat_do_not_populate_process_env"],
};

export const buildAgentsWorker = async (options: { readonly quiet?: boolean } = {}) => {
  const { rolldown } = await import("rolldown");
  const { default: cloudflare } = await import("@alchemy.run/cloudflare-runtime/rolldown");
  const bundle = await rolldown({
    input: path.join(here, "src/worker.ts"),
    cwd: here,
    external: ["cloudflare:workers", "cloudflare:sockets"],
    plugins: [cloudflare({ compatibilityDate: COMPATIBILITY.date, compatibilityFlags: COMPATIBILITY.flags })],
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
  const files: Array<string> = [];
  for (const chunk of out.output) {
    if (chunk.fileName.endsWith(".map")) continue;
    files.push(chunk.fileName);
    bytes += chunk.type === "chunk" ? Buffer.byteLength(chunk.code) : Buffer.byteLength(chunk.source);
  }
  const report = { builtAt: new Date().toISOString(), bytes, files };
  fs.writeFileSync(path.join(here, "dist/build-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet) console.log(`t3flare: built the agents Worker, ${(bytes / 1024 / 1024).toFixed(2)} MiB in ${files.length} files`);
  return report;
};

if (import.meta.main) await buildAgentsWorker();
