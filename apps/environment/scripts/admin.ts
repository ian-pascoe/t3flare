// @effect-diagnostics globalConsole:off globalFetch:off
// Calls an admin route of a stage, through Access (the stage's service token) with the admin token:
//
//   node scripts/stage.ts run <stage> admin POST "/_t3flare/arm-bootstrap?minutes=15"
//   node scripts/stage.ts run <stage> admin POST /_t3flare/sql '{"sql":"SELECT COUNT(*) FROM orchestration_v2_projection_threads"}'
const [method = "GET", pathname = "/_t3flare/health", body] = process.argv.slice(2);
const response = await fetch(new URL(pathname, process.env.T3_URL), {
  method,
  headers: {
    "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "",
    "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "",
    authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN}`,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body }),
});
console.log(response.status, await response.text());
