// @effect-diagnostics globalFetch:off globalConsole:off cryptoRandomUUID:off globalDate:off
// computer's `WorkspaceProxy` (the Container's egress back to its Workspace DO, `ctx.exports.WorkspaceProxy`) with more
// paths, which computer's proxy answers 404 (it forwards only `/api` and its connect callbacks):
//
// - the git credential helper's token request (`CREDENTIAL_PATH`, ADR-0013) and the CLI agents' key helper
//   (`MODEL_KEY_PATH`, step 4a), passed to the Workspace DO as a bodiless GET (only the key helper's nonce header);
// - the CLI agents' MCP relay (`/t3flare/mcp/<server>`, ADR-0028): one MCP message per request, with the process's
//   tool handle, to the Workspace DO and on to the Environment DO;
// - the CLI agents' model relay (`/t3flare/model/<endpointId>/…`, SPI-1167): the Workspace DO checks the process's model
//   handle and gets the endpoint's target from the Environment DO; the request is streamed from here to the endpoint
//   and its answer back, so no Durable Object holds a long stream. Each answer's class goes back to the Workspace DO as
//   the process's last answer (SPI-1172).
//
// Addressed as computer's proxy addresses its host.
import { WorkspaceProxy as ComputerWorkspaceProxy } from "@cloudflare/computer";

import { environmentStub, limitsSender, usageSender } from "./environment.ts";
import { handleRelayRequest, isRelayPath } from "./workspace/mcpRelay.ts";
import { handleModelRelay, isModelRelayPath, workspaceRelayDeps } from "./workspace/modelRelay.ts";
import { CREDENTIAL_PATH, MODEL_KEY_PATH, type WorkspaceDO } from "./workspace/WorkspaceDO.ts";

interface ProxyProps {
  readonly binding: string;
  readonly id: string;
  readonly name?: string;
}

export class WorkspaceProxy extends ComputerWorkspaceProxy {
  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const relay = isRelayPath(pathname);
    const modelRelay = isModelRelayPath(pathname);
    if (pathname !== CREDENTIAL_PATH && pathname !== MODEL_KEY_PATH && !relay && !modelRelay) return super.fetch(request);
    const { binding, id, name } = (this.ctx as unknown as { props: ProxyProps }).props;
    const namespace = (this.env as Record<string, DurableObjectNamespace | undefined>)[binding];
    if (namespace === undefined) return new Response("", { status: 500 });
    const named = name === undefined || name === "" ? undefined : namespace.idFromName(name);
    const target = named !== undefined && named.toString() === id ? named : namespace.idFromString(id);
    const workspace = namespace.get(target);
    if (modelRelay) {
      // SAFETY: the Workspace DO answers `modelRelay` (WorkspaceDO.ts).
      const rpc = workspace as unknown as Pick<WorkspaceDO, "modelRelay" | "modelRelayOutcome">;
      // SPI-1172: each answer reported to the Workspace DO, for the CLI wrapper's view of a failed turn.
      return handleModelRelay(
        request,
        workspaceRelayDeps(rpc, {
          fetch: (upstream) => fetch(upstream),
          log: (event) => console.log(JSON.stringify(event)),
          now: () => Date.now(),
          // Each answer's usage, kept by the Environment for t3's Usage page (SPI-1173).
          usage: usageSender(this.ctx, () => environmentStub((this.env as { readonly ENVIRONMENT: DurableObjectNamespace }).ENVIRONMENT)),
          // Each answer's limit windows (its rate-limit headers), kept by the Environment for t3's limit meters (SPI-1174).
          limits: limitsSender(this.ctx, () => environmentStub((this.env as { readonly ENVIRONMENT: DurableObjectNamespace }).ENVIRONMENT)),
        }),
      ).catch((error: unknown) => {
        // The route logs its own failures; this is what escaped it, with what the path names (never a value).
        const endpoint = /^\/t3flare\/model\/([a-z0-9-]{1,32})(?:\/|$)/.exec(pathname)?.[1] ?? null;
        console.warn(JSON.stringify({ t3flare: "model-relay-failed", endpoint, handle: null, error: error instanceof Error ? error.name : "error" }));
        return new Response("t3flare: the model relay failed\n", { status: 502 });
      });
    }
    if (relay) {
      // SAFETY: the Workspace DO answers `mcpRelay` and `cancelMcpAsk` (WorkspaceDO.ts).
      const rpc = workspace as unknown as Pick<WorkspaceDO, "mcpRelay" | "cancelMcpAsk">;
      return handleRelayRequest(request, {
        relay: (input) => rpc.mcpRelay(input),
        cancel: (askId) => void rpc.cancelMcpAsk({ askId }).catch(() => undefined),
        newId: () => crypto.randomUUID(),
      }).catch((error: unknown) => {
        console.warn(JSON.stringify({ t3flare: "mcp-relay-failed", error: String(error).slice(0, 300) }));
        return new Response("t3flare: the MCP relay failed\n", { status: 502 });
      });
    }
    const nonce = request.headers.get("x-t3flare-nonce");
    return workspace.fetch(new Request(request.url, { method: "GET", ...(nonce === null ? {} : { headers: { "x-t3flare-nonce": nonce } }) }));
  }
}
