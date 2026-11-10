// @effect-diagnostics globalConsole:off globalFetch:off
// Prints the admin health route of a stage, or some of its fields:
//
//   bun scripts/stage.ts run <stage> health [field,field…]
const response = await fetch(new URL("/_t3flare/health", process.env.T3_URL), {
  headers: {
    "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "",
    "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "",
    authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN}`,
  },
});
const health = (await response.json()) as Record<string, unknown>;
const fields = (process.argv[2] ?? "").split(",").filter(Boolean);
console.log(JSON.stringify(fields.length > 0 ? Object.fromEntries(fields.map((f) => [f, health[f]])) : health, null, 1));
