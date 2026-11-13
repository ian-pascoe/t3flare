// One-off evidence for the pnpm migration (plan review M7): what the Workers bundle, by package `name@version`, and
// the export names of each generated dependency stub, so a Bun build and a pnpm build can be diffed.
//
//   node docs/steps/pnpm/bundle-inventory.ts <out.json>     after `node build.ts` in apps/environment and apps/agents
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const out = process.argv[2];
if (out === undefined) throw new Error("usage: node docs/steps/pnpm/bundle-inventory.ts <out.json>");

/** The package that owns a file under node_modules: the directory right after the last `node_modules/`. */
const packageOf = (file: string): string | undefined => {
  const at = file.lastIndexOf("/node_modules/");
  if (at === -1) return undefined;
  const rest = file.slice(at + "/node_modules/".length).split("/");
  const dir = file.slice(0, at + "/node_modules/".length) + (rest[0]!.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]);
  const json = JSON.parse(fs.readFileSync(path.join(fs.realpathSync(dir), "package.json"), "utf8")) as { name: string; version: string };
  return `${json.name}@${json.version}`;
};

const bundled = (worker: string) => {
  const dir = path.join(root, worker, "dist/worker");
  const packages = new Set<string>();
  let ownFiles = 0;
  for (const map of fs.readdirSync(dir).filter((name) => name.endsWith(".js.map"))) {
    const { sources } = JSON.parse(fs.readFileSync(path.join(dir, map), "utf8")) as { sources: Array<string> };
    for (const source of sources) {
      const file = path.resolve(dir, source);
      const pkg = fs.existsSync(file) ? packageOf(file) : undefined;
      if (pkg === undefined) ownFiles++;
      else packages.add(pkg);
    }
  }
  return { packages: [...packages].sort(), ownFiles };
};

// The stubs' export names, read exactly as apps/environment/build.ts's `dependencyStubs` reads them.
const report = JSON.parse(fs.readFileSync(path.join(root, "apps/environment/dist/build-report.json"), "utf8")) as {
  buildShims: { dependencyStubs: Array<string> };
};
const requireFromServer = createRequire(path.join(root, "t3code/apps/server/package.json"));
const stubs: Record<string, Array<string> | string> = {};
for (const source of report.buildShims.dependencyStubs) {
  try {
    const resolved = requireFromServer.resolve(source);
    stubs[source] = Object.keys(await import(resolved))
      .filter((name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name))
      .sort();
  } catch (error) {
    stubs[source] = `unresolved: ${String(error).split("\n")[0]}`;
  }
}

const result = { environment: bundled("apps/environment"), agents: bundled("apps/agents"), stubs };
fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  `environment ${result.environment.packages.length} packages, agents ${result.agents.packages.length}, ` +
    `stubs ${Object.entries(stubs).map(([name, names]) => `${name}:${Array.isArray(names) ? names.length : "x"}`).join(" ")}`,
);
