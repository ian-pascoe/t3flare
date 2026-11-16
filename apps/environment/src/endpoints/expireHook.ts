// The stage-only hook that marks a sign-in's access token expired (SPI-1171), so its next use renews it: a mid-thread
// refresh shown without waiting for the token's real expiry. It answers only where the Environment's faults are on
// (`T3FLARE_FAULTS=1`, which alchemy.run.ts binds on every stage but prod), and never says anything of a token.
export interface ExpireHookDeps {
  /** Whether stage-only checks answer (`environmentServices().faults`). */
  readonly faults: boolean;
  /** The broker's `expire`, through the Environment DO. */
  readonly expire: (endpointId: string) => Promise<boolean>;
}

export const expireHook = async (deps: ExpireHookDeps, endpointId: string): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> => {
  if (!deps.faults) return { status: 403, json: { error: "stages only" } };
  return { status: 200, json: { expired: await deps.expire(endpointId) } };
};
