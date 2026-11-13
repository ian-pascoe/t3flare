// G11's Container previews (ADR-0031; cloudpid's ADR-0023, ported): what a preview browser's page gets from the Workspace
// DO for `http://<port>.t3flare.internal/`, over a fake Container port. The carried sockets' streams need workerd's
// WebSocket and are checked on the stage (`scripts/previews.ts`); their refusals are checked here.
import { describe, expect, it } from "vitest";

import { ContainerPreview, type ContainerPreviewDeps } from "../src/workspace/containerPreview.ts";
import { CONTAINER_PREVIEW_HEADER } from "../src/workspace/containerPreviewScript.ts";

const harness = (options: { running?: boolean; answer?: (request: Request) => Response | Promise<Response> } = {}) => {
  const seen: Array<{ port: number; url: string; host: string | null; forwarded: string | null; cookie: string | null }> = [];
  let used = 0;
  const deps: ContainerPreviewDeps = {
    running: () => options.running ?? true,
    port: (port) =>
      ({
        fetch: async (input: string, init?: RequestInit) => {
          const request = new Request(input, init);
          seen.push({ port, url: request.url, host: request.headers.get("host"), forwarded: request.headers.get("x-forwarded-host"), cookie: request.headers.get("cookie") });
          return (options.answer ?? (() => new Response("<html><head><title>app</title></head><body>hi</body></html>", { headers: { "content-type": "text/html" } })))(request);
        },
      }) as unknown as Fetcher,
    used: async () => {
      used++;
    },
    hold: () => () => undefined,
    newId: () => "a".repeat(64),
    keepAliveMs: () => 15_000,
    warn: () => undefined,
  };
  return { preview: new ContainerPreview(deps), seen, used: () => used };
};

const at = (path: string, init?: RequestInit) => new Request(`http://5173.t3flare.internal${path}`, init);

describe("a Container preview", () => {
  it("answers an HTML page from the Container's port as `localhost`, with the socket script first in its head", async () => {
    const run = harness();
    const response = await run.preview.serve(at("/app?x=1", { headers: { cookie: "session=1", host: "evil.example", "x-forwarded-host": "ws-b" } }), 5173);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("<title>"));
    expect(html).toContain("__t3flareContainerPreview");
    expect(run.seen).toEqual([{ port: 5173, url: "http://localhost:5173/app?x=1", host: "localhost:5173", forwarded: "5173.t3flare.internal", cookie: "session=1" }]);
    expect(run.used()).toBe(1);
  });

  it("points a redirect to the dev server itself back at the preview host, and leaves other redirects", async () => {
    const run = harness({ answer: (request) => new Response(null, { status: 302, headers: { location: request.url.endsWith("/a") ? "http://localhost:5173/b?c=1" : "https://example.com/" } }) });
    expect((await run.preview.serve(at("/a"), 5173)).headers.get("location")).toBe("http://5173.t3flare.internal/b?c=1");
    expect((await run.preview.serve(at("/z"), 5173)).headers.get("location")).toBe("https://example.com/");
  });

  it("links the script as a file for a page with a CSP, and serves it", async () => {
    const run = harness({ answer: () => new Response("<html><head></head></html>", { headers: { "content-type": "text/html", "content-security-policy": "script-src 'self'" } }) });
    expect(await (await run.preview.serve(at("/"), 5173)).text()).toContain('<script src="/__t3flare/ws/shim.js"></script>');
    const shim = await run.preview.serve(at("/__t3flare/ws/shim.js"), 5173);
    expect(shim.headers.get("content-type")).toContain("javascript");
    expect(await shim.text()).toContain("CarriedSocket");
  });

  it("never starts a stopped Container, and is not use then", async () => {
    const run = harness({ running: false });
    const response = await run.preview.serve(at("/"), 5173);
    expect(response.status).toBe(503);
    expect(run.seen).toEqual([]);
    expect(run.used()).toBe(0);
  });

  it("serves only the eight ports: computerd's 8080 asks nothing of the Container", async () => {
    const run = harness();
    expect((await run.preview.serve(new Request("http://8080.t3flare.internal/"), 8080)).status).toBe(404);
    expect(run.seen).toEqual([]);
  });

  it("says to listen on 0.0.0.0 when nothing answers", async () => {
    const run = harness({ answer: () => Promise.reject(new Error("connection refused")) });
    const response = await run.preview.serve(at("/"), 5173);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("0.0.0.0");
  });

  it("refuses the socket endpoints without the header, from another origin, or for an id it never gave", async () => {
    const run = harness();
    expect((await run.preview.serve(at("/__t3flare/ws/send?id=x", { method: "POST", body: "hi" }), 5173)).status).toBe(403);
    expect((await run.preview.serve(at("/__t3flare/ws/send?id=x", { method: "POST", body: "hi", headers: { [CONTAINER_PREVIEW_HEADER]: "1", origin: "https://evil.example" } }), 5173)).status).toBe(403);
    expect((await run.preview.serve(at("/__t3flare/ws/send?id=x", { method: "POST", body: "hi", headers: { [CONTAINER_PREVIEW_HEADER]: "1", origin: "http://5173.t3flare.internal" } }), 5173)).status).toBe(404);
    expect(run.seen).toEqual([]);
  });
});
