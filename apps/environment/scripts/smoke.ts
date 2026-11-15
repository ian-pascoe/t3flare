// @effect-diagnostics globalConsole:off globalFetch:off globalDate:off globalTimers:off
// A post-deploy smoke check that leaves nothing behind: the web client answers, and the admin health route (read-only;
// it neither boots t3 nor starts a Container) answers through Access with the admin token, reports the expected build,
// and is not in safe mode. Prints only non-secret health fields. Retries for six minutes: an active Environment DO (an
// open client socket) keeps its old code until it hibernates or Cloudflare's default code-update delay of 5 minutes ends.
//
// It also checks that the host's root OAuth documents are still t3's (ADR-0036, plan D13; acceptance step 2b's two
// assertions): with managed OAuth on the Owner-client endpoint's Access application (layout (B)), drift in Access (a
// beta) answering them would send t3's own MCP clients to Access's authorization server, and this is the check every
// prod deploy runs. Public, no credential; t3 answers them, so they boot it in the Environment DO (no Container).
//
//   node scripts/stage.ts run <stage> smoke [<commit>]
const expected = (process.argv[2] ?? "").slice(0, 12);
const url = process.env.T3_URL ?? "";
const deadline = Date.now() + 360_000;

/** A root well-known document: its status and JSON body (undefined when it is not JSON). */
const wellKnown = async (pathname: string) => {
  const response = await fetch(new URL(pathname, url), { redirect: "manual", headers: { accept: "application/json" } });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: response.status, json: undefined };
  }
};

/** Why the root OAuth documents are not t3's, or undefined. */
const rootOAuthFailure = async (): Promise<string | undefined> => {
  const origin = new URL(url).origin;
  const authorizationServer = await wellKnown("/.well-known/oauth-authorization-server");
  if (authorizationServer.status !== 200 || authorizationServer.json?.issuer !== origin) {
    return `the root authorization-server document is not t3's (${authorizationServer.status}, issuer ${String(authorizationServer.json?.issuer)})`;
  }
  const protectedResource = await wellKnown("/.well-known/oauth-protected-resource");
  const servers = protectedResource.json?.authorization_servers;
  if (protectedResource.status !== 200 || protectedResource.json?.resource !== `${origin}/mcp` || !Array.isArray(servers) || !servers.every((server) => server === origin)) {
    return `the root protected-resource document is not t3's /mcp (${protectedResource.status}, resource ${String(protectedResource.json?.resource)})`;
  }
  return undefined;
};

const attempt = async (): Promise<string | undefined> => {
  const page = await fetch(new URL("/", url));
  if (page.status !== 200) return `GET / answered ${page.status}`;
  const response = await fetch(new URL("/_t3flare/health", url), {
    headers: {
      "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "",
      "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "",
      authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN}`,
    },
  });
  if (response.status !== 200) return `GET /_t3flare/health answered ${response.status}`;
  const health = (await response.json()) as { build?: { commit?: string }; safeMode?: { on?: boolean }; runtime?: string };
  console.log(JSON.stringify({ build: health.build, safeMode: health.safeMode, runtime: health.runtime }));
  if (expected !== "" && health.build?.commit !== expected) return `build ${health.build?.commit}, expected ${expected}`;
  if (health.safeMode?.on) return "the Environment is in safe mode";
  return rootOAuthFailure();
};

for (;;) {
  const failure = await attempt().catch((error: unknown) => String(error));
  if (failure === undefined) {
    console.log(`smoke: ${url} ok`);
    break;
  }
  if (Date.now() > deadline) {
    console.error(`smoke: ${failure}`);
    process.exit(1);
  }
  console.error(`smoke: ${failure}; retrying`);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
