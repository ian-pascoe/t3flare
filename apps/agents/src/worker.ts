// The agents Worker (ADR-0014): the Session DOs, the Workspace DOs with their Container, and the Container budget. It
// has no public URL: the environment Worker reaches it through Durable Object bindings only. Its entry also exports
// computer's proxies: `WorkspaceServiceProxy`, through which the Worker Shell's loaded Worker reaches its Workspace DO,
// and `WorkspaceProxy`, which carries the Container's egress back (`ctx.exports`).
export { WorkspaceServiceProxy } from "@cloudflare/computer";
export { WorkspaceProxy } from "./workspaceProxy.ts";

export { ContainerBudget } from "./budget.ts";
export { SessionDO } from "./session/SessionDO.ts";
export { WorkspaceDO } from "./workspace/WorkspaceDO.ts";

export default {
  fetch(): Response {
    return new Response("Not found\n", { status: 404 });
  },
};
