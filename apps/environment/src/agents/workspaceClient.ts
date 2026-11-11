// The environment Worker's client of the Workspace DOs (step 2a plan, section 2): t3 paths (`/w/<id>/…`) in, the
// Workspace DO's own paths (`/workspace/repo/…`) on the wire. An id the registry does not list never reaches a DO.
import { toWorkspace } from "@t3flare/workspace-client";

import { environmentServices } from "./bindings.ts";
import { byName, type WorkspaceRpc } from "./rpc.ts";
import type { WorkspaceRecord } from "./workspaces.ts";

export interface Located {
  readonly id: string;
  /** The path inside the Workspace. */
  readonly inner: string;
  readonly record: WorkspaceRecord;
  readonly rpc: WorkspaceRpc;
}

/** Workspace DO stubs handed out, by id (the unlisted-id check proves none is made for an unlisted id). */
export const workspaceStubs = new Map<string, number>();

export const workspaceRpc = (id: string): WorkspaceRpc => {
  workspaceStubs.set(id, (workspaceStubs.get(id) ?? 0) + 1);
  return byName(environmentServices().agents.WORKSPACES, id, "WORKSPACES");
};

/** The Workspace a t3 path is in, or undefined when the path is not in a listed Workspace that resolves (not being deleted). */
export const locate = (path: string): Located | undefined => {
  const at = toWorkspace(path);
  if (at === null) return undefined;
  const record = environmentServices().workspaces.resolve(at.id);
  if (record === undefined) return undefined;
  return { id: at.id, inner: at.inner, record, rpc: workspaceRpc(at.id) };
};
