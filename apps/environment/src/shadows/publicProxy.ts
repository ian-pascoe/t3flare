// Shadow of t3code `apps/server/src/htmlRender/publicProxy.ts` (G11's M1, ADR-0031; ADR-0001). Stock runs a SOCKS5
// server on loopback that refuses local and private addresses, and points the HTML-render Chrome at it. workerd has no
// `node:net` server, and the render's Chrome here is Browser Run (`preview/htmlBrowser.ts`), which takes no proxy flag:
// its egress is Cloudflare's, which reaches no address of this account's private network, and its policy refuses
// loopback and `*.localhost` (M0, `docs/steps/previews/m0-summary.json`). So the proxy is a no-op with stock's shape:
// `headlessChrome.ts` passes its port in a flag the bridge ignores, and there are never fake-IP hosts to report.
import * as Effect from "effect/Effect";

export const publicProxy: Effect.Effect<{ readonly port: number; readonly fakeIpHosts: ReadonlyMap<string, string> }, Error> = Effect.succeed({
  port: 0,
  fakeIpHosts: new Map<string, string>(),
});
