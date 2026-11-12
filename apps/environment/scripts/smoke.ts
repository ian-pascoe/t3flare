// @effect-diagnostics globalConsole:off globalFetch:off globalDate:off globalTimers:off
// A post-deploy smoke check that leaves nothing behind: the web client answers, and the admin health route (read-only;
// it neither boots t3 nor starts a Container) answers through Access with the admin token, reports the expected build,
// and is not in safe mode. Prints only non-secret health fields. Retries for six minutes: an active Environment DO (an
// open client socket) keeps its old code until it hibernates or Cloudflare's default code-update delay of 5 minutes ends.
//
//   node scripts/stage.ts run <stage> smoke [<commit>]
const expected = (process.argv[2] ?? "").slice(0, 12);
const url = process.env.T3_URL ?? "";
const deadline = Date.now() + 360_000;

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
  return undefined;
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
