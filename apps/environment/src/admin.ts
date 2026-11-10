// @effect-diagnostics globalDate:off globalConsole:off
// The spike's admin routes (`/_t3flare/*`, ADR-0010: behind a token here, Access too from
// step 1): boot timings, the SQL probes for the step 0 checks, and a forced restart.
import type { DurableObjectState } from "@cloudflare/workers-types/index.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as DoSql from "./platform/sql.ts";
import { spawnAttempts } from "./platform/services.ts";
import type { Runtime } from "./runtime.ts";

export interface AdminContext {
  readonly ctx: DurableObjectState;
  readonly env: { readonly T3FLARE_ADMIN_TOKEN?: string };
  readonly stats: Record<string, number>;
  readonly runtime: () => Promise<Runtime>;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value, null, 2), { status, headers: { "content-type": "application/json" } });

class Rollback {
  readonly _tag = "Rollback";
}

const sqlProbe = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const results: Record<string, unknown> = {};
  yield* sql`DROP TABLE IF EXISTS t3flare_probe`;
  yield* sql`CREATE TABLE t3flare_probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`;

  // 1. withTransaction with rollback, and a nested savepoint rolled back on its own.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO t3flare_probe (id, label) VALUES (1, 'rolled back')`;
      return yield* Effect.fail(new Rollback());
    }),
  ).pipe(Effect.catchTag("Rollback", () => Effect.void));
  const afterRollback = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM t3flare_probe`;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO t3flare_probe (id, label) VALUES (2, 'outer kept')`;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO t3flare_probe (id, label) VALUES (3, 'inner rolled back')`;
            return yield* Effect.fail(new Rollback());
          }),
        )
        .pipe(Effect.catchTag("Rollback", () => Effect.void));
    }),
  );
  const afterNested = yield* sql<{ id: number }>`SELECT id FROM t3flare_probe ORDER BY id`;
  results.transactionRollback = {
    rowsAfterRolledBackTransaction: afterRollback[0]?.n,
    rowsAfterNestedSavepointRollback: afterNested.map((row) => row.id),
    ok: afterRollback[0]?.n === 0 && afterNested.length === 1 && afterNested[0]?.id === 2,
  };

  // 2. More than 100 bound parameters: a 150-row insert and a 150-id IN list.
  const before = DoSql.inlinedStatements.count;
  const ids = Array.from({ length: 150 }, (_, i) => 1000 + i);
  yield* sql`INSERT INTO t3flare_probe ${sql.insert(ids.map((id): Record<string, unknown> => ({ id, label: `row '${id}' ?` })) as unknown as Record<string, unknown>)}`;
  const found = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM t3flare_probe WHERE id IN ${sql.in(ids)}`;
  const quoted = yield* sql<{ label: string }>`SELECT label FROM t3flare_probe WHERE id = ${1007}`;
  results.overHundredParameters = {
    parameters: ids.length * 2,
    found: found[0]?.n,
    labelRoundTrip: quoted[0]?.label,
    statementsInlined: DoSql.inlinedStatements.count - before,
    ok: found[0]?.n === 150 && quoted[0]?.label === "row '1007' ?",
  };

  // 3. Read latency behind an open transaction: a read issued while a 50 ms transaction
  // is open waits for it (no separate reader, unlike t3's Node client).
  const reads: Array<number> = [];
  const t0 = performance.now();
  yield* Effect.all(
    [
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE t3flare_probe SET label = 'locked' WHERE id = 2`;
          yield* Effect.sleep("50 millis");
        }),
      ),
      Effect.gen(function* () {
        yield* Effect.sleep("5 millis");
        const start = performance.now();
        yield* sql`SELECT label FROM t3flare_probe WHERE id = 2`;
        reads.push(performance.now() - start);
      }),
    ],
    { concurrency: "unbounded" },
  );
  const baseline = performance.now();
  for (let i = 0; i < 20; i++) yield* sql`SELECT label FROM t3flare_probe WHERE id = 2`;
  results.readBehindTransaction = {
    readWaitMs: reads[0],
    totalMs: performance.now() - t0,
    uncontendedReadMs: (performance.now() - baseline) / 20,
  };
  yield* sql`DROP TABLE t3flare_probe`;
  return results;
});

export const handleAdmin = async (request: Request, admin: AdminContext): Promise<Response> => {
  const token = admin.env.T3FLARE_ADMIN_TOKEN;
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`) {
    return new Response("Not found", { status: 404 });
  }
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/_t3flare/stats":
      return json({
        stats: admin.stats,
        inlinedStatements: DoSql.inlinedStatements,
        spawnAttempts: Object.fromEntries(spawnAttempts),
      });
    case "/_t3flare/boot": {
      const started = performance.now();
      const runtime = await admin.runtime();
      return json({ wallMs: performance.now() - started, bootMs: runtime.bootMs, stats: admin.stats });
    }
    case "/_t3flare/probe/sql": {
      const result = await Effect.runPromise(
        sqlProbe.pipe(Effect.provide(DoSql.layer(admin.ctx.storage)), Effect.scoped),
      );
      return json(result);
    }
    case "/_t3flare/restart": {
      // Resets the object as an eviction or deploy would: memory and sockets go, storage stays.
      admin.ctx.abort("t3flare: restart requested");
      return json({ aborted: true });
    }
    default:
      return new Response("Not found", { status: 404 });
  }
};
