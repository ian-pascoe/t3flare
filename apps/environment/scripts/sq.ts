// @effect-diagnostics globalConsole:off
// Step 3 (debugging): one read-only SQL statement against the stage's Environment DO (the admin route).
//
//   node scripts/stage.ts run step3 sq "<statement>"
import { admin } from "./lib/client.ts";
const q = process.argv[2]!;
console.log(JSON.stringify((await admin("POST", "/_t3flare/sql", { sql: q, params: [] })).json).slice(0, 3000));
