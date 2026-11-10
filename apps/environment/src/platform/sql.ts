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

// DO SQLite allows at most 5 terms in one compound SELECT (SQLite's default is 500);
// t3 unions up to ~15 sections in one statement. Longer chains are regrouped into nested
// subqueries of at most 5 terms, left to right, which keeps their meaning.
export const MAX_COMPOUND_TERMS = 5;
export const rewrittenCompounds = { count: 0, maxTerms: 0 };

const COMPOUND_OPERATOR = /^(UNION\s+ALL|UNION|INTERSECT|EXCEPT)\b/i;

/** Calls `visit` for each character index at paren depth 0, outside quotes and comments. */
const scanTopLevel = (text: string, visit: (index: number) => number | void) => {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "'" || char === '"' || char === "`") {
      const end = text.indexOf(char, i + 1);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (char === "-" && text[i + 1] === "-") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0) {
      const skip = visit(i);
      if (typeof skip === "number") i = skip - 1;
    }
  }
};

const wordAt = (text: string, index: number) =>
  (index === 0 || !/[\w$]/.test(text[index - 1]!)) ? text.slice(index) : "";

const rewriteLevel = (text: string): string => {
  // Children first: every parenthesized region is a query level of its own.
  let out = "";
  let depth = 0;
  let start = -1;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "'" || char === '"' || char === "`") {
      const end = text.indexOf(char, i + 1);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (char === "-" && text[i + 1] === "-") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (char === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0 && start !== -1) {
        out += text.slice(last, start + 1) + rewriteLevel(text.slice(start + 1, i));
        last = i;
        start = -1;
      }
    }
  }
  out += text.slice(last);

  const operators: Array<{ index: number; length: number; op: string }> = [];
  scanTopLevel(out, (i) => {
    const match = COMPOUND_OPERATOR.exec(wordAt(out, i));
    if (match) {
      operators.push({ index: i, length: match[0].length, op: match[1]!.replace(/\s+/g, " ").toUpperCase() });
      return i + match[0].length;
    }
  });
  const termCount = operators.length + 1;
  if (termCount <= MAX_COMPOUND_TERMS) return out;

  const terms: Array<string> = [];
  let from = 0;
  for (const { index, length } of operators) {
    terms.push(out.slice(from, index));
    from = index + length;
  }
  terms.push(out.slice(from));

  // A leading WITH and a trailing ORDER BY / LIMIT belong to the whole compound.
  let prefix = "";
  const first = terms[0]!;
  if (/^\s*WITH\b/i.test(first)) {
    let selectAt = -1;
    scanTopLevel(first, (i) => {
      if (selectAt === -1 && /^SELECT\b/i.test(wordAt(first, i))) selectAt = i;
    });
    if (selectAt > 0) {
      prefix = first.slice(0, selectAt);
      terms[0] = first.slice(selectAt);
    }
  }
  let suffix = "";
  const lastTerm = terms[terms.length - 1]!;
  let tailAt = -1;
  scanTopLevel(lastTerm, (i) => {
    if (tailAt === -1 && /^(ORDER\s+BY|LIMIT)\b/i.test(wordAt(lastTerm, i))) tailAt = i;
  });
  if (tailAt !== -1) {
    suffix = lastTerm.slice(tailAt);
    terms[terms.length - 1] = lastTerm.slice(0, tailAt);
  }

  let acc = terms[0]!;
  let next = 1;
  while (terms.length - next > MAX_COMPOUND_TERMS - 1) {
    let group = acc;
    for (let k = 0; k < MAX_COMPOUND_TERMS - 1; k++, next++) group += ` ${operators[next - 1]!.op} ${terms[next]}`;
    acc = `SELECT * FROM (${group})`;
  }
  for (; next < terms.length; next++) acc += ` ${operators[next - 1]!.op} ${terms[next]}`;
  rewrittenCompounds.count++;
  rewrittenCompounds.maxTerms = Math.max(rewrittenCompounds.maxTerms, termCount);
  return `${prefix}${acc} ${suffix}`;
};

const MANY_OPERATORS = /\b(UNION|INTERSECT|EXCEPT)\b/gi;

export const rewriteCompoundSelects = (query: string): string => {
  const count = query.match(MANY_OPERATORS)?.length ?? 0;
  return count < MAX_COMPOUND_TERMS ? query : rewriteLevel(query);
};

export const withParameterInlining = (sql: SqlStorage): SqlStorage =>
  new Proxy(sql, {
    get(target, property) {
      if (property === "exec") {
        return (raw: string, ...params: Array<unknown>) => {
          const query = rewriteCompoundSelects(raw);
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
