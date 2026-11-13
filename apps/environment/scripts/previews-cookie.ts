// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// G11 stage check helper: a paired browser session's cookie, written to a 0600 file for a local browser's check of the
// published page (review L1, the opaque origin); never printed.
import * as fs from "node:fs";

import { base, pair } from "./lib/client.ts";

const cookie = await pair();
fs.writeFileSync("/tmp/previews-cookie", cookie, { mode: 0o600 });
console.log(`cookie for ${base.host} written to /tmp/previews-cookie`);
