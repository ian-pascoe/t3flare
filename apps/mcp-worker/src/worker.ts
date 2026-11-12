// The MCP Worker, `t3flare-mcp-<stage>` (ADR-0028; cloudpid's apps/mcp-worker, its ADR-0038): the MCP SDK's ~10 MiB of
// heap kept out of the agents and Environment isolates. It exports `McpEngine`, the stateless entrypoint the
// Environment DO's MCP host calls over a service binding for every MCP list and call (Commissary, direct servers, OAuth
// and token refresh included: review M5). It has no bindings (review M3) and runs with `global_fetch_strictly_public`
// (`engine/compatibility.ts`), so a server-supplied URL reaches only the public Internet, through every front door.
// `engine/` is cloudpid's engine as copied at 93ba45a3 (vendor/cloudpid/README.md), unchanged; stdio targets fail there,
// since this Worker has no Container bridge (stdio servers are refused, OD-T12).
export { McpEngine } from "./engine/engine.ts";

/** Reached over RPC only. */
export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
