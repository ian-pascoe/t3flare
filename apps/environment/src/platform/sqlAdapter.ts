// @effect-diagnostics globalDate:off
// The DO SQLite adapter (ADR-0006): rewrites t3's statements around what Durable Object SQLite refuses.
//
// | DO SQLite limit                                            | Adapter                                        |
// |------------------------------------------------------------|------------------------------------------------|
// | 100 bound parameters                                       | inline escaped literals above 100              |
// | 5 terms per compound SELECT                                | regroup UNION chains into nested subqueries    |
// | ~100 view/subquery expansions per statement (production)   | run each CTE alone, pass rows on via json_each |
// | storage PRAGMAs t3 reads every minute are not authorized   | answered here with 0 (cost audit F8)          |
//
// Everything here is pure text work over `SqlStorage.exec`, so it is tested on Node against real SQLite
// (test/sqlAdapter.test.ts) and in workerd against DO SQLite (test/sqlAdapter.workerd.test.ts).
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

export const MAX_BOUND_PARAMETERS = 100;
export const MAX_COMPOUND_TERMS = 5;

/** What the adapter did since the isolate started; read by the admin health route. */
export const sqlStats = {
  statementsInlined: 0,
  maxParameters: 0,
  compoundsRewritten: 0,
  maxCompoundTerms: 0,
  ctesMaterialized: 0,
  materializeFailures: 0,
  /** Rows DO SQLite reports t3's statements wrote and read (cost audit F2); writes are what DO SQLite bills most. */
  rowsWritten: 0,
  rowsRead: 0,
  /** The last statements DO SQLite refused (at most 20), truncated. */
  errors: [] as Array<{ readonly at: string; readonly message: string; readonly sql: string }>,
};

const recordError = (message: string, sql: string) => {
  sqlStats.errors.push({ at: new Date().toISOString(), message, sql: sql.slice(0, 4000) });
  if (sqlStats.errors.length > 20) sqlStats.errors.shift();
};

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
  if (ArrayBuffer.isView(value)) return `X'${hex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))}'`;
  throw new Error(`Cannot inline SQL parameter of type ${typeof value}`);
};

/** Index of the end of a quoted string or comment starting at `i`, or -1 when `i` starts neither. */
const skipQuotedOrComment = (text: string, i: number): number => {
  const char = text[i];
  if (char === "'" || char === '"' || char === "`") {
    const end = text.indexOf(char, i + 1);
    return end === -1 ? text.length : end;
  }
  if (char === "-" && text[i + 1] === "-") {
    const end = text.indexOf("\n", i);
    return end === -1 ? text.length : end - 1;
  }
  if (char === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 1;
  }
  return -1;
};

/**
 * Replaces each `?` placeholder outside quoted text and comments with its literal. The compiler t3 uses
 * (`Statement.makeCompilerSqlite`) emits positional `?` only.
 */
export const inlineParameters = (sql: string, params: ReadonlyArray<unknown>): string => {
  let out = "";
  let next = 0;
  for (let i = 0; i < sql.length; i++) {
    const skip = skipQuotedOrComment(sql, i);
    if (skip !== -1) {
      out += sql.slice(i, skip + 1);
      i = skip;
      continue;
    }
    if (sql[i] === "?") {
      if (next >= params.length) throw new Error("More placeholders than parameters");
      out += sqlLiteral(params[next++]);
      continue;
    }
    out += sql[i];
  }
  if (next !== params.length) throw new Error("More parameters than placeholders");
  return out;
};

const COMPOUND_OPERATOR = /^(UNION\s+ALL|UNION|INTERSECT|EXCEPT)\b/i;

/** Calls `visit` for each index at paren depth 0, outside quotes and comments; it may return where to resume. */
const scanTopLevel = (text: string, visit: (index: number) => number | void) => {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const skip = skipQuotedOrComment(text, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    const char = text[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0) {
      const resume = visit(i);
      if (typeof resume === "number") i = resume - 1;
    }
  }
};

/** The text from `index` when a word starts there, else "". */
const wordAt = (text: string, index: number) => (index === 0 || !/[\w$]/.test(text[index - 1]!) ? text.slice(index) : "");

const rewriteLevel = (text: string): string => {
  // Children first: every parenthesized region is a query level of its own.
  let out = "";
  let depth = 0;
  let start = -1;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const skip = skipQuotedOrComment(text, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    const char = text[i];
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
    if (match === null) return;
    operators.push({ index: i, length: match[0].length, op: match[1]!.replace(/\s+/g, " ").toUpperCase() });
    return i + match[0].length;
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

  // Left to right: the first five terms become one subquery, which is the first term of the next five.
  let acc = terms[0]!;
  let next = 1;
  while (terms.length - next > MAX_COMPOUND_TERMS - 1) {
    let group = acc;
    for (let k = 0; k < MAX_COMPOUND_TERMS - 1; k++, next++) group += ` ${operators[next - 1]!.op} ${terms[next]}`;
    acc = `SELECT * FROM (${group})`;
  }
  for (; next < terms.length; next++) acc += ` ${operators[next - 1]!.op} ${terms[next]}`;
  sqlStats.compoundsRewritten++;
  sqlStats.maxCompoundTerms = Math.max(sqlStats.maxCompoundTerms, termCount);
  return `${prefix}${acc} ${suffix}`;
};

const ANY_OPERATOR = /\b(UNION|INTERSECT|EXCEPT)\b/gi;

/** Regroups every compound SELECT of more than five terms, at any nesting level. */
export const rewriteCompoundSelects = (query: string): string =>
  (query.match(ANY_OPERATOR)?.length ?? 0) < MAX_COMPOUND_TERMS ? query : rewriteLevel(query);

export interface Cte {
  readonly name: string;
  readonly columns: string | null;
  readonly body: string;
}

const skipSpace = (text: string, i: number) => {
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text.startsWith("--", i)) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    return i;
  }
};

/** Index just past the parenthesis group opening at `open`. */
const closeParen = (text: string, open: number) => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const skip = skipQuotedOrComment(text, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i + 1;
  }
  throw new Error("Unbalanced parentheses");
};

/** A non-recursive `WITH` statement's CTEs and main statement, or null for anything else. */
export const splitWith = (query: string): { ctes: Array<Cte>; main: string } | null => {
  let i = skipSpace(query, 0);
  if (!/^WITH\b/i.test(query.slice(i))) return null;
  i = skipSpace(query, i + 4);
  if (/^RECURSIVE\b/i.test(query.slice(i))) return null;
  const ctes: Array<Cte> = [];
  for (;;) {
    const name = /^[A-Za-z_][\w$]*/.exec(query.slice(i))?.[0];
    if (name === undefined) return null;
    i = skipSpace(query, i + name.length);
    let columns: string | null = null;
    if (query[i] === "(") {
      const end = closeParen(query, i);
      columns = query.slice(i, end);
      i = skipSpace(query, end);
    }
    const as = /^AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?/i.exec(query.slice(i));
    if (as === null) return null;
    i += as[0].length;
    if (query[i] !== "(") return null;
    const end = closeParen(query, i);
    ctes.push({ name, columns, body: query.slice(i + 1, end - 1) });
    i = skipSpace(query, end);
    if (query[i] === ",") {
      i = skipSpace(query, i + 1);
      continue;
    }
    return { ctes, main: query.slice(i) };
  }
};

const NOT_ALIAS = new Set([
  "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "CROSS", "FULL", "OUTER", "NATURAL", "ON", "USING",
  "GROUP", "ORDER", "LIMIT", "UNION", "INTERSECT", "EXCEPT", "WINDOW", "HAVING", "AS",
]);

/** A cursor over rows already read: what `materializeCtes` returns in place of `SqlStorage.exec`'s. */
export type Rows = ReturnType<SqlStorage["exec"]>;

const rowsCursor = (columnNames: Array<string>, rows: Array<Array<unknown>>): Rows => {
  const cursor = {
    columnNames,
    rowsRead: 0,
    rowsWritten: 0,
    raw: () => rows[Symbol.iterator](),
    toArray: () => rows.map((row) => Object.fromEntries(columnNames.map((c, k) => [c, row[k]]))),
    one: () => {
      if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
      return Object.fromEntries(columnNames.map((c, k) => [c, rows[0]![k]]));
    },
    next: (() => {
      let index = 0;
      return () =>
        index < rows.length
          ? { done: false, value: Object.fromEntries(columnNames.map((c, k) => [c, rows[index++]![k]])) }
          : { done: true, value: undefined };
    })(),
    [Symbol.iterator]() {
      return cursor.toArray()[Symbol.iterator]();
    },
  };
  return cursor as unknown as Rows;
};

/**
 * Runs each CTE as its own statement, then hands its rows to the statements that read it as a
 * `json_each` parameter instead of a nested query. `query` must have no `?` placeholders (inline them
 * first). Returns null when the statement is not a plain `WITH` this can split. No DDL: scratch tables
 * invalidated cursors t3 still had open (step 0).
 */
export const materializeCtes = (target: SqlStorage, query: string): Rows | null => {
  const split = splitWith(query);
  if (split === null || split.ctes.some((cte) => cte.columns !== null)) return null;
  const data: Array<{ name: string; columns: ReadonlyArray<string>; json: string }> = [];
  const substitute = (text: string) => {
    const params: Array<string> = [];
    let out = text;
    for (const cte of data) {
      out = out.replace(
        new RegExp(`\\b(FROM|JOIN)(\\s+)${cte.name}\\b(\\s*)([A-Za-z_]*)`, "gi"),
        (_m, keyword: string, space: string, space2: string, next: string) => {
          params.push(cte.json);
          const columns = cte.columns.map((c, k) => `json_extract(value, '$[${k}]') AS "${c}"`).join(", ");
          const aliased = next !== "" && !NOT_ALIAS.has(next.toUpperCase());
          const explicit = next.toUpperCase() === "AS";
          const alias = aliased || explicit ? "" : ` AS ${cte.name}`;
          return `${keyword}${space}(SELECT ${columns} FROM json_each(?${params.length}))${alias}${space2}${next}`;
        },
      );
    }
    return { sql: out, params };
  };
  const run = (text: string) => {
    const { sql, params } = substitute(text);
    const cursor = counted(target.exec(sql, ...params));
    const columns = cursor.columnNames;
    const rows = Array.from(cursor.raw()) as Array<Array<unknown>>;
    for (const row of rows) {
      // json_each cannot carry a blob back out unchanged.
      if (row.some((value) => value instanceof ArrayBuffer)) throw new Error("A CTE row holds a blob");
    }
    return { columns, rows };
  };
  for (const cte of split.ctes) {
    const { columns, rows } = run(cte.body);
    data.push({ name: cte.name, columns, json: JSON.stringify(rows) });
  }
  const { columns, rows } = run(split.main);
  sqlStats.ctesMaterialized++;
  return rowsCursor(columns, rows);
};

const NESTED_TOO_DEEP = "nested too deep";

/**
 * The cursor, adding to `sqlStats` the rows it read and wrote as it is consumed: DO SQLite counts them as the rows are
 * stepped, so every call on the cursor, or on an iterator it hands out, settles the difference.
 */
const counted = (cursor: Rows): Rows => {
  let read = 0;
  let written = 0;
  const settle = () => {
    sqlStats.rowsRead += cursor.rowsRead - read;
    sqlStats.rowsWritten += cursor.rowsWritten - written;
    read = cursor.rowsRead;
    written = cursor.rowsWritten;
  };
  const settling = <T extends object>(inner: T): T => {
    const proxy: T = new Proxy(inner, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: Array<unknown>) => {
          const out: unknown = value.apply(target, args);
          settle();
          if (out === target) return proxy;
          return typeof out === "object" && out !== null && typeof (out as { next?: unknown }).next === "function" ? settling(out) : out;
        };
      },
    });
    return proxy;
  };
  settle();
  return settling(cursor);
};

/**
 * The storage PRAGMAs t3's DatabaseStorage reads every minute that DO SQLite does not authorize, in their read form:
 * answered with 0. `auto_vacuum` 0 (none) means t3 never runs an incremental vacuum and its "reclaim space" answers
 * that T3 Code must stop; it then reads `page_count` and `freelist_count` for its Storage page.
 */
const STORAGE_PRAGMA_READ = /^\s*PRAGMA\s+(auto_vacuum|page_count|freelist_count)\s*;?\s*$/i;

/** `exec` with the adapter's rewrites: what t3's SQL client calls through `storageForClient`. */
export const adaptedExec = (target: SqlStorage, raw: string, params: ReadonlyArray<unknown>): Rows => {
  const pragma = STORAGE_PRAGMA_READ.exec(raw)?.[1];
  if (pragma !== undefined) return rowsCursor([pragma.toLowerCase()], [[0]]);
  let query = rewriteCompoundSelects(raw);
  let bound = params;
  if (params.length > MAX_BOUND_PARAMETERS) {
    sqlStats.statementsInlined++;
    sqlStats.maxParameters = Math.max(sqlStats.maxParameters, params.length);
    query = inlineParameters(query, params);
    bound = [];
  }
  try {
    return counted(target.exec(query, ...bound));
  } catch (error) {
    if (String(error).includes(NESTED_TOO_DEEP)) {
      try {
        const fallback = materializeCtes(target, bound.length === 0 ? query : inlineParameters(query, bound));
        if (fallback !== null) return fallback;
      } catch (fallbackError) {
        sqlStats.materializeFailures++;
        recordError(`materialize: ${String(fallbackError)}`, query);
      }
    }
    recordError(String(error), query);
    throw error;
  }
};

/** An `SqlStorage` whose `exec` goes through the adapter; every other member is the real one's. */
export const adaptSqlStorage = (sql: SqlStorage): SqlStorage =>
  new Proxy(sql, {
    get(target, property) {
      if (property === "exec") {
        return (raw: string, ...params: Array<unknown>) => adaptedExec(target, raw, params);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
