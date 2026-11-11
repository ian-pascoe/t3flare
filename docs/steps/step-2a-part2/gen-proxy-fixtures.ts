// Step 2a part 2, M0: the model proxy's error answers on its Anthropic Messages entry, made by Commissary's own code
// (read only; nothing in Commissary is changed). Run from anywhere with Commissary checked out:
//
//   COMMISSARY=~/src/commissary bun docs/steps/step-2a-part2/gen-proxy-fixtures.ts > packages/models/test/fixtures/proxy.json
//
// Each fixture is what a client of `POST /v1/messages` receives: status, the headers Commissary sets itself, and the
// body; `stream` ones are the SSE `event: error` frame sent after a 200 began.
const root = process.env.COMMISSARY ?? `${process.env.HOME}/src/commissary`;
const m = (rel: string) => import(`${root}/${rel}`);

const { modelCooldown, spendLimitReached, authUnavailable, authNotFound } = await m("packages/models/src/credentials/selection/failures.ts");
const { ExecutionError } = await m("packages/models/src/executor/errors.ts");
// `pickFailureError` of packages/models/src/executor/control-plane-picker.ts:67-82, copied: that module imports the
// Workers runtime (`cloudflare:workers`), which a script cannot load.
const pickFailureError = (failure: { code: string; message: string; httpStatus?: number; retryAfterSeconds?: number; body?: string }) =>
  new ExecutionError({
    status: failure.httpStatus ?? 503,
    code: failure.code,
    message: failure.body ?? failure.message,
    ...(failure.retryAfterSeconds === undefined
      ? {}
      : { retryAfterMs: failure.retryAfterSeconds * 1000, safeHeaders: { "retry-after": String(failure.retryAfterSeconds) } }),
  });
const { errorResponse } = await m("packages/models/src/handlers/respond.ts");
const { claudeFramer } = await m("packages/models/src/handlers/framing.ts");
const { accessErrorResponse } = await m("packages/auth/src/refusal.ts");
const { UnauthorizedError, ForbiddenError, RateLimitedError } = await m("packages/core/src/errors.ts");
const { Effect } = await import(`${root}/node_modules/effect/dist/index.js`).catch(() => m("node_modules/effect/dist/esm/index.js"));
const { commit } = { commit: Bun.spawnSync(["git", "-C", root, "rev-parse", "--short=8", "HEAD"]).stdout.toString().trim() };

const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const MODEL = "claude-haiku-5-5";

const decode = (body: unknown): string => {
  const b = body as { _tag?: string; body?: unknown };
  if (b._tag === "Uint8Array") return new TextDecoder().decode(b.body as Uint8Array);
  if (typeof b.body === "string") return b.body;
  throw new Error(`unknown body ${JSON.stringify(b)}`);
};
const answer = (response: { status: number; headers: Record<string, string>; body: unknown }) => ({
  status: response.status,
  headers: Object.fromEntries(Object.entries(response.headers).filter(([name]) => name !== "content-type" && name !== "content-length")),
  body: decode(response.body),
});
const viaHandler = (error: unknown) => answer(errorResponse("claude", error, { passthroughHeaders: false }));
const viaGate = (error: unknown) => answer(Effect.runSync(accessErrorResponse(error)));
const inStream = (error: unknown) => claudeFramer().terminalError(error);

const upstreamLimit = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." } });

const cooldown = pickFailureError(modelCooldown(MODEL, "claude", 2 * 3600_000 + 3 * 60_000 + 4_000));
const fixtures = {
  source: `commissary@${commit}`,
  now: new Date(NOW).toISOString(),
  model: MODEL,
  answers: {
    cooldown: viaHandler(cooldown),
    cooldownShort: viaHandler(pickFailureError(modelCooldown(MODEL, "claude", 120_000))),
    upstreamLimitWithRetryAfter: viaHandler(new ExecutionError({ status: 429, message: upstreamLimit, safeHeaders: { "retry-after": "5400" } })),
    upstreamLimit: viaHandler(new ExecutionError({ status: 429, message: upstreamLimit })),
    spendLimit: viaHandler(pickFailureError(spendLimitReached({ kind: "key", period: "day", resetsAt: NOW + 14 * 3600_000 }, NOW))),
    requestRate: viaGate(new RateLimitedError({ message: "Rate limit exceeded", retryAfterSeconds: 60 })),
    invalidKey: viaGate(new UnauthorizedError({ message: "Invalid API key" })),
    missingKey: viaGate(new UnauthorizedError({ message: "Missing API key" })),
    forbidden: viaGate(new ForbiddenError({ message: "Forbidden" })),
    accountRejected: viaHandler(new ExecutionError({ status: 401, message: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) })),
    noAccount: viaHandler(new ExecutionError({ status: 503, code: "auth_not_found", message: "no auth available" })),
    accountUnavailable: viaHandler(pickFailureError(authUnavailable(NOW + 90_000, NOW))),
    noAccountAtAll: viaHandler(pickFailureError(authNotFound())),
    overloaded: viaHandler(new ExecutionError({ status: 529, message: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) })),
    serverError: viaHandler(new ExecutionError({ status: 502, message: "upstream connect error" })),
  },
  streamed: {
    cooldown: inStream(cooldown),
    upstreamLimit: inStream(new ExecutionError({ status: 429, message: upstreamLimit })),
    overloaded: inStream(new ExecutionError({ status: 529, message: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) })),
  },
};
process.stdout.write(`${JSON.stringify(fixtures, null, 2)}\n`);
