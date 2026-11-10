// t3's SQL client on Durable Object SQLite (ADR-0006).
//
// The stock `@effect/sql-sqlite-do` client, created with `storage` so `withTransaction`
// runs through `storage.transaction()`. DO SQLite binds at most 100 parameters per
// statement and t3 exceeds that (unchunked `sql.in(...)`), so statements over the limit
// have their parameters inlined as escaped literals before they reach `SqlStorage.exec`.
import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types/index.ts";
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as Layer from "effect/Layer";

export const MAX_BOUND_PARAMETERS = 100;

/** Counts how many statements had their parameters inlined; read by the spike's probes. */
export const inlinedStatements = { count: 0, maxParams: 0 };

const hex = (bytes: Uint8Array) => {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
};

export const sqlLiteral = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot inline non-finite number ${value}`);
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (value instanceof ArrayBuffer) return `X'${hex(new Uint8Array(value))}'`;
  if (ArrayBuffer.isView(value)) {
    return `X'${hex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))}'`;
  }
  throw new Error(`Cannot inline SQL parameter of type ${typeof value}`);
};

/**
 * Replaces each `?` placeholder outside quoted text and comments with its literal.
 * The compiler t3 uses (`Statement.makeCompilerSqlite`) emits positional `?` only.
 */
export const inlineParameters = (sql: string, params: ReadonlyArray<unknown>): string => {
  let out = "";
  let next = 0;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    if (char === "'" || char === '"' || char === "`") {
      const end = sql.indexOf(char, i + 1);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop + 1);
      i = stop;
      continue;
    }
    if (char === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (char === "?") {
      if (next >= params.length) throw new Error("More placeholders than parameters");
      out += sqlLiteral(params[next++]);
      continue;
    }
    out += char;
  }
  if (next !== params.length) throw new Error("More parameters than placeholders");
  return out;
};

export const withParameterInlining = (sql: SqlStorage): SqlStorage =>
  new Proxy(sql, {
    get(target, property) {
      if (property === "exec") {
        return (query: string, ...params: Array<unknown>) => {
          if (params.length <= MAX_BOUND_PARAMETERS) return target.exec(query, ...params);
          inlinedStatements.count++;
          inlinedStatements.maxParams = Math.max(inlinedStatements.maxParams, params.length);
          return target.exec(inlineParameters(query, params));
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/** The storage view the client sees: inlining `sql`, the real `transaction`. */
export const storageForClient = (storage: DurableObjectStorage): DurableObjectStorage =>
  ({
    sql: withParameterInlining(storage.sql),
    transaction: storage.transaction.bind(storage),
  }) as unknown as DurableObjectStorage;

export const layer = (storage: DurableObjectStorage) =>
  SqliteClient.layer({
    storage: storageForClient(storage),
    spanAttributes: { "db.name": "environment", "service.name": "t3flare-environment" },
  });
