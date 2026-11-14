// @effect-diagnostics globalConsole:off
// SPI-1175: the workflows' first step after the setup, before anything that could print the endpoint: masks the key and
// header values of the secret `T3FLARE_MODEL_ENDPOINT` in the job's log, each on its own (GitHub masks only the whole
// JSON string). It writes to the runner's own stdout, never to a file or a captured output (bump.ts keeps its steps'
// output in bump-report.json), so the commands themselves are never kept.
//
//   T3FLARE_MODEL_ENDPOINT=… node apps/environment/scripts/mask-endpoint.ts
import { maskCommands } from "./lib/modelEndpointSpec.ts";

for (const command of maskCommands(process.env)) console.log(command);
