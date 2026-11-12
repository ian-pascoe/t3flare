// @effect-diagnostics globalFetch:off globalConsole:off cryptoRandomUUID:off
// computer's `WorkspaceProxy` (the Container's egress back to its Workspace DO, `ctx.exports.WorkspaceProxy`) with more
// paths, which computer's proxy answers 404 (it forwards only `/api` and its connect callbacks):
//
// - the git credential helper's token request (`CREDENTIAL_PATH`, ADR-0013) and the CLI agents' key helper
//   (`MODEL_KEY_PATH`, step 4a), passed to the Workspace DO as a bodiless GET (only the key helper's nonce header);
// - the push gateway (`GATEWAY_PREFIX`, SPI-992): the Container's `git push` (rerouted by `pushInsteadOf` in the image's
//   system gitconfig), forwarded to GitHub with the write token after the Workspace DO's policy allowed its exact ref
//   updates. The request body streams through this Worker; it never goes through the DO.
//
// Addressed as computer's proxy addresses its host.
import { WorkspaceProxy as ComputerWorkspaceProxy } from "@cloudflare/computer";

import { GATEWAY_PREFIX, handleGitRequest } from "./workspace/pushGateway.ts";
import { CREDENTIAL_PATH, MODEL_KEY_PATH, type WorkspaceDO } from "./workspace/WorkspaceDO.ts";

interface ProxyProps {
  readonly binding: string;
  readonly id: string;
  readonly name?: string;
}

export class WorkspaceProxy extends ComputerWorkspaceProxy {
  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const gateway = pathname.startsWith(GATEWAY_PREFIX);
    if (pathname !== CREDENTIAL_PATH && pathname !== MODEL_KEY_PATH && !gateway) return super.fetch(request);
    const { binding, id, name } = (this.ctx as unknown as { props: ProxyProps }).props;
    const namespace = (this.env as Record<string, DurableObjectNamespace | undefined>)[binding];
    if (namespace === undefined) return new Response("", { status: 500 });
    const named = name === undefined || name === "" ? undefined : namespace.idFromName(name);
    const target = named !== undefined && named.toString() === id ? named : namespace.idFromString(id);
    const workspace = namespace.get(target);
    if (gateway) {
      // SAFETY: the Workspace DO answers `pushTarget` and `authorizePush` (WorkspaceDO.ts).
      const rpc = workspace as unknown as Pick<WorkspaceDO, "pushTarget" | "authorizePush" | "cancelPushAsk">;
      const pushTarget = await rpc.pushTarget().catch(() => null);
      return handleGitRequest(request, {
        repo: pushTarget?.repo ?? null,
        token: () => (pushTarget === null ? Promise.reject(new Error("no push target")) : Promise.resolve(pushTarget.token)),
        authorize: (push, signal) => {
          // git went away while the owner was asked (review M7): the card is withdrawn.
          const askId = crypto.randomUUID();
          signal.addEventListener("abort", () => void rpc.cancelPushAsk({ askId }).catch(() => undefined));
          return rpc.authorizePush({ ...push, askId });
        },
        fetch: (input, init) => fetch(input, init),
      }).catch((error: unknown) => {
        console.warn(JSON.stringify({ t3flare: "push-gateway-failed", error: String(error).slice(0, 300) }));
        return new Response("t3flare: the push gateway failed\n", { status: 502 });
      });
    }
    const nonce = request.headers.get("x-t3flare-nonce");
    return workspace.fetch(new Request(request.url, { method: "GET", ...(nonce === null ? {} : { headers: { "x-t3flare-nonce": nonce } }) }));
  }
}
