// computer's `WorkspaceProxy` (the Container's egress back to its Workspace DO, `ctx.exports.WorkspaceProxy`) with one
// more path each for the git credential helper's token request (`CREDENTIAL_PATH`, ADR-0013) and the CLI agents' key
// helper (`MODEL_KEY_PATH`, step 4a), which computer's proxy answers 404 (it forwards only `/api` and its connect
// callbacks). Addressed as computer's proxy addresses its host. Only the key helper's nonce header is passed on.
import { WorkspaceProxy as ComputerWorkspaceProxy } from "@cloudflare/computer";

import { CREDENTIAL_PATH, MODEL_KEY_PATH } from "./workspace/WorkspaceDO.ts";

interface ProxyProps {
  readonly binding: string;
  readonly id: string;
  readonly name?: string;
}

export class WorkspaceProxy extends ComputerWorkspaceProxy {
  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname !== CREDENTIAL_PATH && pathname !== MODEL_KEY_PATH) return super.fetch(request);
    const { binding, id, name } = (this.ctx as unknown as { props: ProxyProps }).props;
    const namespace = (this.env as Record<string, DurableObjectNamespace | undefined>)[binding];
    if (namespace === undefined) return new Response("", { status: 500 });
    const named = name === undefined || name === "" ? undefined : namespace.idFromName(name);
    const target = named !== undefined && named.toString() === id ? named : namespace.idFromString(id);
    const nonce = request.headers.get("x-t3flare-nonce");
    return namespace.get(target).fetch(new Request(request.url, { method: "GET", ...(nonce === null ? {} : { headers: { "x-t3flare-nonce": nonce } }) }));
  }
}
