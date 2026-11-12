// The SDK stays in the MCP Worker (OD-T5; cloudpid's packages/mcp/src/sdk-isolation.test.ts, ported): the MCP SDK adds
// about 9-10 MiB of cold heap to every isolate that loads it, and the agents Worker's isolates hold Sessions and
// Workspaces (ADR-0014), the Environment Worker's t3. Checked on the module graph, as cloudpid does: a module in the graph
// is one the isolate may evaluate.
//
// - The agents Worker's whole graph, bundled with its own build's Rolldown options: no `@modelcontextprotocol/` module.
// - `@cloudpid/mcp/types` and `@cloudpid/mcp/oauth` (what the Environment's MCP host may import): no SDK module.
// - The Environment Worker's own sources (its full bundle carries t3 and its shims, too slow here): no import of the SDK
//   or of `@cloudpid/mcp` other than those two entries.
// A planted import proves each check can fail.
// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off preferEffectArray:off
import * as fs from "node:fs";
import { resolve } from "node:path";
import cloudflare from "@alchemy.run/cloudflare-runtime/rolldown";
import { rolldown, type Plugin } from "rolldown";
import { describe, expect, it } from "vitest";

const here = (path: string) => resolve(import.meta.dirname, path);
const SDK = "@modelcontextprotocol/";
const AGENTS = here("../../agents/src/worker.ts");
const ENVIRONMENT_SRC = here("../../environment/src");
const TYPES = here("../../../vendor/cloudpid/mcp/src/types.ts");
const OAUTH = here("../../../vendor/cloudpid/mcp/src/oauth.ts");
const CORE = here("../../../vendor/cloudpid/mcp/src/index.ts");

const PLANTED = "\0planted";
const planted = (entry: string, extra: ReadonlyArray<string>): Plugin => ({
  name: "planted",
  resolveId(source, importer) {
    if (source === PLANTED) return source;
    if (importer !== PLANTED || source === entry) return null;
    return this.resolve(source, CORE, { skipSelf: true });
  },
  load(id) {
    if (id !== PLANTED) return null;
    return [`import * as entry from ${JSON.stringify(entry)}; globalThis.entry = entry;`, ...extra.map((source) => `import ${JSON.stringify(source)};`)].join("\n");
  },
});

/** Every module id in `entry`'s graph (with `extra` imports planted beside it). */
const graphOf = async (entry: string, extra: ReadonlyArray<string> = []): Promise<ReadonlyArray<string>> => {
  const build = await rolldown({
    input: extra.length === 0 ? entry : PLANTED,
    cwd: here(".."),
    external: ["cloudflare:workers", "cloudflare:sockets"],
    plugins: [...(extra.length === 0 ? [] : [planted(entry, extra)]), cloudflare({ compatibilityDate: "2026-11-01", compatibilityFlags: ["nodejs_compat"] })],
    checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
    logLevel: "silent",
  });
  const output = await build.generate({ format: "esm" });
  await build.close();
  return output.output.flatMap((chunk) => (chunk.type === "chunk" ? chunk.moduleIds : []));
};

const sdkModules = (ids: ReadonlyArray<string>) => ids.filter((id) => id.includes(SDK));

const sources = (dir: string): ReadonlyArray<string> =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : [];
  });

/** An import the Environment Worker may not make: the SDK, or `@cloudpid/mcp` beyond its types and OAuth entries. */
const forbiddenImports = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/from\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/g)]
    .map((match) => match[1] ?? match[2] ?? "")
    .filter((source) => source.startsWith(SDK) || (source.startsWith("@cloudpid/mcp") && !["@cloudpid/mcp/types", "@cloudpid/mcp/oauth"].includes(source)));

describe("the MCP SDK stays in the MCP Worker", () => {
  it("the agents Worker's graph has no SDK module, and a planted import is caught", async () => {
    expect(sdkModules(await graphOf(AGENTS))).toEqual([]);
    expect(sdkModules(await graphOf(AGENTS, ["@modelcontextprotocol/client"])).length).toBeGreaterThan(0);
  }, 120_000);

  it("@cloudpid/mcp/types and /oauth load nothing of the SDK", async () => {
    expect(sdkModules(await graphOf(TYPES))).toEqual([]);
    expect(sdkModules(await graphOf(OAUTH))).toEqual([]);
    expect(sdkModules(await graphOf(CORE)).length).toBeGreaterThan(0);
  }, 120_000);

  it("the Environment Worker's sources import neither the SDK nor @cloudpid/mcp's core", () => {
    const found = sources(ENVIRONMENT_SRC).flatMap((file) => forbiddenImports(fs.readFileSync(file, "utf8")).map((source) => `${file}: ${source}`));
    expect(found).toEqual([]);
    expect(forbiddenImports(`import { connect } from "@cloudpid/mcp";`)).toEqual(["@cloudpid/mcp"]);
  });
});
