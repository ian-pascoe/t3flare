// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Writes the harness panel rendered from its fixture state (test/fixtures/harnessPage.ts) to a file, for a look in a
// browser without a stage (SPI-1086). `empty` renders the first-run state: no MCP server and no audit entry.
//
//   node scripts/panel-preview.ts <out.html> [empty]
import fs from "node:fs";

import { renderPage } from "../src/harness/page.ts";
import { fixturePage } from "../test/fixtures/harnessPage.ts";

const [out, variant] = process.argv.slice(2);
if (out === undefined) {
  console.error("usage: panel-preview.ts <out.html> [empty]");
  process.exit(2);
}
fs.writeFileSync(out, renderPage(fixturePage(variant === "empty" ? { mcp: [], audit: [] } : {})));
console.log(`wrote ${out}`);
