// @effect-diagnostics globalConsole:off globalFetch:off globalDate:off globalTimers:off nodeBuiltinImport:off
// The publish-only T3 Connect link of a stage (step 3+, ADR-0025), through its admin routes (src/connect/admin.ts):
//
//   bun scripts/stage.ts run <stage> connect sign-in [--owner]   start t3's device flow; prints the code and URL for the
//                                                               owner to approve, then waits until the link is made
//   bun scripts/stage.ts run <stage> connect status [--relay]    the flow, the link, secrets held (names), recent publishes
//   bun scripts/stage.ts run <stage> connect publish on|off      t3's publish switch
//   bun scripts/stage.ts run <stage> connect relink|unlink|sign-out
//   bun scripts/stage.ts run <stage> connect import-token <file> R1 fallback: a token file from `t3 connect login --headless`
//   bun scripts/stage.ts run <stage> connect probe               P2: the relay and Clerk reached from the DO
//   bun scripts/stage.ts run <stage> connect refusals            the relay routes: 404 at the door, refused inside t3
//
// `--owner` (required on prod for every change, review finding 6) sends the owner's own Access token from
// `cloudflared access token -app <url>` (after `cloudflared access login <url>`) instead of the stage's service token.
// Nothing secret is printed: the user code and URL are what the owner types or opens.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

const base = new URL(process.env.T3_URL ?? "http://localhost:8791");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const [command, ...rest] = args.filter((arg) => !arg.startsWith("--"));

const accessHeaders = (): Record<string, string> => {
  if (flag("owner")) {
    // Access guards only `<host>/_t3flare` (ADR-0010), so the application is named by that path, not the origin.
    const app = new URL("/_t3flare", base).href;
    const result = spawnSync("cloudflared", ["access", "token", "-app", app], { encoding: "utf8" });
    const token = result.stdout.trim();
    if (result.status !== 0 || token === "") {
      console.error(`t3flare: no owner Access token; run \`cloudflared access login ${app}\` first`);
      process.exit(2);
    }
    return { "cf-access-token": token };
  }
  return process.env.T3FLARE_ACCESS_CLIENT_ID && process.env.T3FLARE_ACCESS_CLIENT_SECRET
    ? { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID, "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET }
    : {};
};
const headers = accessHeaders();

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const response = await fetch(new URL(path, base), {
    method,
    redirect: "manual",
    headers: { ...headers, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch {
    return { status: response.status, json: text.slice(0, 300) };
  }
};

const print = (value: unknown) => console.log(JSON.stringify(value, null, 1));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

switch (command) {
  case "sign-in": {
    const started = await call("POST", "/_t3flare/connect/sign-in");
    if (started.status !== 200) {
      print(started);
      process.exit(1);
    }
    const prompt = started.json as { userCode: string; verificationUri: string; verificationUriComplete: string | null; expiresInSeconds: number };
    console.log(`Open ${prompt.verificationUriComplete ?? prompt.verificationUri}`);
    console.log(`and approve the code ${prompt.userCode} (valid ${Math.round(prompt.expiresInSeconds / 60)} min).`);
    const until = Date.now() + prompt.expiresInSeconds * 1000 + 30_000;
    while (Date.now() < until) {
      await sleep(5000);
      const status = await call("GET", "/_t3flare/connect/status");
      const state = status.json?.flow?.state;
      if (state === "linked" || state === "failed") {
        print({ flow: status.json.flow, link: status.json.link, secretsHeld: status.json.secretsHeld, accountToken: status.json.accountToken });
        process.exit(state === "linked" ? 0 : 1);
      }
    }
    console.error("t3flare: the code expired without a link");
    process.exit(1);
  }
  case "status":
    print((await call("GET", `/_t3flare/connect/status${flag("relay") ? "?relay=1" : ""}`)).json);
    break;
  case "publish": {
    const on = rest[0];
    if (on !== "on" && on !== "off") throw new Error("publish on|off");
    print(await call("POST", `/_t3flare/connect/publish?on=${on === "on" ? 1 : 0}`));
    break;
  }
  case "relink":
  case "unlink":
  case "sign-out":
    print(await call("POST", `/_t3flare/connect/${command}`));
    break;
  case "import-token": {
    const file = rest[0];
    if (file === undefined) throw new Error("import-token <file>");
    const token = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const result = await call("POST", "/_t3flare/connect/import-token", token);
    print(result);
    if (result.status === 200) console.log(`Linked. Delete ${file} now: the cloud is the token's only holder.`);
    break;
  }
  case "probe":
    print(await call("POST", "/_t3flare/connect/probe"));
    break;
  case "refusals": {
    // At the door: every method and spelling of the four relay routes, without credentials (as the relay would call).
    const paths = [
      "/api/connect/link-proof",
      "/api/connect/relay-config",
      "/api/t3-connect/health",
      "/api/t3-connect/mint-credential",
      "/api/t3-connect/mint-credential/",
      "/API/T3-CONNECT/MINT-CREDENTIAL",
      "/api/t3-connect/mint%2Dcredential",
      "/api/t3%2Dconnect/health",
      "//api/connect//link-proof",
    ];
    const door: Record<string, number | string> = {};
    for (const path of paths) {
      for (const method of ["GET", "POST", "PUT", "OPTIONS"]) {
        // Not `new URL(path, base)`: a path starting `//` would name another host.
        const response = await fetch(`${base.origin}${path}`, {
          method,
          redirect: "manual",
          ...(method === "POST" || method === "PUT" ? { headers: { "content-type": "application/json" }, body: '{"proof":"a.b.c"}' } : {}),
        });
        await response.text();
        // A spelling the Worker does not route to the DO (`/API/…`, case-sensitive) gets the web client's assets.
        const assets = !(response.headers.get("content-type") ?? "").includes("json") && response.status !== 404;
        door[`${method} ${path}`] = assets ? `assets ${response.status}` : response.status;
      }
    }
    const kept: Record<string, number> = {};
    for (const [method, path] of [["GET", "/api/connect/link-state"], ["POST", "/api/connect/preferences"], ["POST", "/api/connect/unlink"], ["POST", "/api/connect/reachability"]] as const) {
      const response = await fetch(new URL(path, base), { method, redirect: "manual", ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
      await response.text();
      kept[`${method} ${path}`] = response.status;
    }
    const inside = await call("POST", "/_t3flare/check/connect-refusals");
    const allDoor404 = Object.values(door).every((status) => status === 404 || String(status).startsWith("assets"));
    // mint and health need no session, so t3's refusal (403) answers; link-proof and relay-config need one first (401).
    const insideRefused = Object.entries(inside.json as Record<string, { status: number }>).every(([path, answer]) =>
      path.startsWith("/api/t3-connect/") ? answer.status === 403 : answer.status === 401 || answer.status === 403,
    );
    print({ door, allDoor404, kept, inside: inside.json, insideRefused });
    process.exit(allDoor404 && insideRefused ? 0 : 1);
  }
  default:
    console.error("usage: connect sign-in|status|publish on|off|relink|unlink|sign-out|import-token <file>|probe|refusals [--owner] [--relay]");
    process.exit(2);
}
