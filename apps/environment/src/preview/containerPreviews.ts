// @effect-diagnostics globalConsole:off asyncFunction:off
// Where Browser Run sends a preview browser's requests for the Container preview hosts (ADR-0031; cloudpid's ADR-0023):
// `outboundByHost`, fixed when the browser is acquired, maps each of the eight `http://<port>.t3flare.internal/` hosts to
// this entrypoint, made with `ctx.exports.ContainerPreviews({ props: { workspace } })` for the browser's one Workspace.
// The props are the browser's identity: nothing in the request (Host, headers, path) can name another Workspace.
import { WorkerEntrypoint } from "cloudflare:workers";

import { isAnyWorkspaceId } from "@t3flare/workspace-client";

import { containerPreviewPortOf } from "./browserRun.ts";
import { spikePage } from "./spikePages.ts";

/** The agents Worker's entrypoint for Container previews, as this Worker binds it: the preview alone. */
export interface WorkspaceContainerPreviewsBinding {
  containerPreview(workspace: string, request: Request, port: number): Promise<Response>;
}

export interface ContainerPreviewsEnv {
  readonly WORKSPACE_PREVIEWS?: WorkspaceContainerPreviewsBinding;
  readonly T3FLARE_FAULTS?: string;
}

/** What a browser's routes are made with: its Workspace's id (`/w/<id>`, a worktree's `.wt/…` included). */
export interface ContainerPreviewProps {
  readonly workspace: string;
}

/** M0's spike Workspaces (test stages only): answered here, never by a Container. */
const SPIKE_WORKSPACE = /^spike-[a-z0-9-]{1,32}$/;

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export class ContainerPreviews extends WorkerEntrypoint<ContainerPreviewsEnv, ContainerPreviewProps> {
  override async fetch(request: Request): Promise<Response> {
    const port = containerPreviewPortOf(new URL(request.url));
    if (port === undefined) return text(404, "Not a Container preview host.");
    const workspace = this.ctx.props.workspace;
    if (this.env.T3FLARE_FAULTS === "1" && SPIKE_WORKSPACE.test(workspace)) return spikePage(request, workspace, port);
    const previews = this.env.WORKSPACE_PREVIEWS;
    if (previews === undefined || !isAnyWorkspaceId(workspace)) return text(502, "The Workspace could not be reached.");
    try {
      return await previews.containerPreview(workspace, request, port);
    } catch (cause) {
      // Never the request's URL or headers (L5): the page's own paths and cookies stay out of the logs.
      console.warn(JSON.stringify({ t3flare: "container-preview-failed", port, error: cause instanceof Error ? cause.name : "error" }));
      return text(502, "The Workspace could not be reached. Reload to try again.");
    }
  }
}
