// @effect-diagnostics asyncFunction:off
// The agents Worker's entrypoint for Container previews (G11's M3, ADR-0031): the Environment Worker's `ContainerPreviews`
// (Browser Run's `outboundByHost` target, made for one Workspace) hands each request here over a service binding. It
// reaches one method of one Workspace DO, `containerPreview`, for the Workspace id it is given, and nothing else; the id
// comes from the entrypoint's props, never from the request. The Worker has no public URL, so only that binding reaches it.
import { isAnyWorkspaceId } from "@t3flare/workspace-client";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { WorkspaceDO } from "./workspace/WorkspaceDO.ts";

interface PreviewsEnv {
  readonly WORKSPACES: DurableObjectNamespace<WorkspaceDO>;
}

export class WorkspaceContainerPreviews extends WorkerEntrypoint<PreviewsEnv> {
  async containerPreview(workspace: string, request: Request, port: number): Promise<Response> {
    if (!isAnyWorkspaceId(workspace) || !Number.isInteger(port)) return new Response("Not found", { status: 404 });
    // SAFETY: the Workspace DO answers `containerPreview` (WorkspaceDO.ts); the stub's RPC type only rewrites its declared type.
    const stub = this.env.WORKSPACES.get(this.env.WORKSPACES.idFromName(workspace)) as unknown as Pick<WorkspaceDO, "containerPreview">;
    return stub.containerPreview(request, port);
  }
}
