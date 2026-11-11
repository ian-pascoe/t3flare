// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// Step 3, M5: a one-time pairing code from the stage (a client pairing, or a link's), written to a 0600 file and not
// printed, for typing into the desktop app.
//
//   bun scripts/stage.ts run step3 mint-code <file>
import * as fs from "node:fs";

import { base, pair } from "./lib/client.ts";
import { mintPairingCode } from "./lib/peer.ts";

const file = process.argv[2] ?? "";
const { code } = await mintPairingCode(await pair(), { label: "desktop demo" });
fs.writeFileSync(file, code, { mode: 0o600 });
console.log(JSON.stringify({ host: base.host, written: file }));
