// The admin forwarder Worker, `t3flare-admin-<stage>` (ADR-0026, review H4): the harness panel's own host, behind its
// own Access application (the owner and the stage's service token). It holds nothing and decides nothing: every request
// goes over a service binding to the Environment Worker's `HarnessAdmin` entrypoint, which verifies Access again and
// serves the panel. So the panel never shares an origin with t3's web client. Bundled by alchemy (ADR-0020's
// refinement): it imports nothing.
interface ForwarderEnv {
  readonly HARNESS: { fetch(request: Request): Promise<Response> };
}

export default {
  fetch: (request: Request, env: ForwarderEnv): Promise<Response> => env.HARNESS.fetch(request),
};
