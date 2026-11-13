// The Storage page's database row in the Cloud Environment (parity batch 2): a Layer over t3's `DatabaseStorage`
// (ADR-0001). t3 reads its file's size and free pages through PRAGMAs DO SQLite does not authorize; the SQL adapter
// answers those with 0 so nothing fails (`platform/sqlAdapter.ts`, U8), which left the page showing a 0-byte database.
// What is answerable here: the database's size, from Durable Object storage itself (`SqlStorage.databaseSize`). What
// is not: free pages, and a repair, since the platform owns the file. So the page shows the real size, no reclaimable
// space and a database that needs no repair, and a request to reclaim says why there is nothing to do. t3's history
// compaction (the same service's six-hourly prune of the event store) runs as stock.
import { DatabaseReclaimError, type DatabaseStorageStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as DatabaseStorage from "t3/src/persistence/DatabaseStorage.ts";

/** What stands where t3 prints its offline repair command: there is none to run. */
export const NO_REPAIR = "Not needed: Cloudflare manages this Environment's Durable Object storage.";
export const NOTHING_TO_RECLAIM = "This Environment's database lives in Durable Object storage, which Cloudflare manages: there is no space to reclaim here.";

/** How often an open Storage page sees the size again (t3's own pass is every minute). */
export const SIZE_EVERY = "1 minute";

/** The status the page shows for a database of `databaseBytes`. */
export const durableObjectStatus = (databaseBytes: number): DatabaseStorageStatus => ({
  databaseBytes,
  reclaimableBytes: 0,
  incrementalVacuumEnabled: true,
  compactCommand: NO_REPAIR,
  canReclaim: false,
});

/** t3's service with the size read from Durable Object storage and the repair refused. */
export const withDurableObjectSize = (
  stock: DatabaseStorage.DatabaseStorage["Service"],
  databaseSize: () => number,
): DatabaseStorage.DatabaseStorage["Service"] => ({
  reclaim: stock.reclaim,
  status: Stream.fromEffectSchedule(
    Effect.sync((): DatabaseStorageStatus | null => durableObjectStatus(databaseSize())),
    Schedule.spaced(SIZE_EVERY),
  ).pipe(Stream.changesWith((a, b) => a?.databaseBytes === b?.databaseBytes)),
  requestReclaim: Effect.fail(new DatabaseReclaimError({ reason: NOTHING_TO_RECLAIM })),
});

/** `stock` is t3's `DatabaseStorage.layer` with its dependencies; `databaseSize` reads the DO's SQLite size. */
export const layer = <E, R>(stock: Layer.Layer<DatabaseStorage.DatabaseStorage, E, R>, databaseSize: () => number) =>
  Layer.effect(
    DatabaseStorage.DatabaseStorage,
    Effect.map(Effect.service(DatabaseStorage.DatabaseStorage), (service) => withDurableObjectSize(service, databaseSize)),
  ).pipe(Layer.provide(stock));
