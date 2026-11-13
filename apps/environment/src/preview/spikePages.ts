// Test stages only (G11's M0 and the stage checks, `scripts/previews.ts`): the pages a spike Workspace's routes answer
// in place of a Container, so the browser side can be checked without one. Never reached on prod: `ContainerPreviews`
// answers them only with `T3FLARE_FAULTS=1` and a `spike-…` Workspace.
const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(`<!doctype html><html><head><meta charset="utf-8"><title>spike</title></head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const spikePage = (request: Request, workspace: string, port: number): Response => {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/download":
      return new Response("download-ok\n", {
        headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="probe.txt"' },
      });
    case "/upload":
      return html(
        `<input type="file" id="f" multiple><pre id="out">none</pre><script>document.getElementById("f").addEventListener("change", async (e) => { const files = [...e.target.files]; document.getElementById("out").textContent = JSON.stringify(await Promise.all(files.map(async (f) => ({ name: f.name, size: f.size, text: (await f.text()).slice(0, 40) })))); });</script>`,
      );
    case "/frame":
      return html(`<p id="inner">frame-${escape(workspace)}</p>`);
    case "/echo":
      return Response.json({ workspace, port, method: request.method, host: request.headers.get("host"), path: url.pathname });
    case "/cookie":
      return html(`<p>cookie</p>`, { "set-cookie": "spike=1; Path=/; Max-Age=3600" });
    case "/ws":
      return new Response("no sockets here", { status: 426 });
    default:
      return html(
        `<h1 id="props">${escape(workspace)}</h1><p id="port">${port}</p><pre id="host">${escape(request.headers.get("host") ?? "")}</pre>` +
          `<select id="s"><option>a</option><option>b</option></select><input id="t"><button id="b" onclick="document.getElementById('t').value='clicked'">go</button>` +
          `<a id="pop" href="/frame" target="_blank">popup</a><iframe id="fr" src="/frame"></iframe>`,
      );
  }
};
