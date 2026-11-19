// @effect-diagnostics globalConsole:off
// The descriptor's flags the pinned t3 has and `src/t3/capabilities.ts` does not classify (fragility U4): each is stripped
// until it is. Prints them as a JSON array; the bump puts them in its report and its pull request's body.
//
//   node scripts/capabilities-unclassified.ts
import { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";

import { unclassifiedCapabilities } from "../src/t3/capabilities.ts";

console.log(JSON.stringify(unclassifiedCapabilities(Object.keys(ExecutionEnvironmentCapabilities.fields))));
