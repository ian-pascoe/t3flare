// The stage-only hook that marks a sign-in's access token expired (SPI-1171), so its next use renews it: a mid-thread
// refresh shown without waiting for the token's real expiry. `POST /_t3flare/check/sign-in-expire?id=<endpointId>`
// answers only where the Environment's faults are on (`T3FLARE_FAULTS=1`, which alchemy.run.ts binds on every stage but
// prod), takes only an endpoint id, and never says anything of a token.
import { ENDPOINT_ID } from "@t3flare/models/endpoints";

export interface ExpireHookDeps {
  /** Whether stage-only checks answer (`environmentServices().faults`). */
  readonly faults: () => boolean;
  /** The broker's `expire`, through the Environment DO. */
  readonly expire: (endpointId: string) => Promise<boolean>;
}

/**
 * The Environment DO's own check, whoever calls its `expireSignIn` (the route is one caller): `expire` runs only where
 * `T3FLARE_FAULTS` is `"1"`; elsewhere nothing is touched and the answer is false.
 */
export const expireOnStage = async (faults: string | undefined, expire: () => Promise<boolean>): Promise<boolean> => (faults === "1" ? expire() : false);

/** The admin route's answer for `url`. */
export const expireRoute = async (url: URL, deps: ExpireHookDeps): Promise<Response> => {
  const answer = (value: unknown, status: number) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  if (!deps.faults()) return answer({ error: "stages only" }, 403);
  const id = url.searchParams.get("id") ?? "";
  if (!ENDPOINT_ID.test(id)) return answer({ error: "?id= is a Model endpoint's id" }, 400);
  return answer({ expired: await deps.expire(id) }, 200);
};
