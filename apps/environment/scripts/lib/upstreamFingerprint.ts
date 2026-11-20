// @effect-diagnostics nodeBuiltinImport:off
// The upstream fingerprint (SPI-1011, fragility T2). Some of our files restate or emulate t3 code that typecheck
// cannot watch: composition.ts restates server.ts's layer graph, terminal/layer.ts restates TerminalManager.make, the
// stale reads match t3's git argv, the gh emulation answers t3's auth schema. The fixture
// (test/fixtures/upstream-fingerprint.json) ties each to a hash of t3's region, or to a literal that must still appear
// in t3's source, so that a change upstream fails `pnpm run check` (and with it the bump) until our file is reviewed.
//
// A region is a file and a symbol: a top-level declaration's name, a dotted path into its body (`make.capabilities`
// is the first `capabilities` declared or keyed anywhere inside `make`, shallowest first), or `*` for every top-level
// statement but the imports. Its text, without comments, is normalised so a reflow alone does not change its hash.
import { createHash } from "node:crypto";

import { parseSync } from "rolldown/utils";

/** The command that rewrites the fixture's hashes once our files are reviewed. */
export const UPDATE_COMMAND = "node apps/environment/scripts/upstream-fingerprint.ts --update";
const FIXTURE_PATH = "apps/environment/test/fixtures/upstream-fingerprint.json";

export interface RegionSpec {
  readonly symbol: string;
  /**
   * Leave out the object's plain `key: true` properties. For the descriptor's capabilities: t3 adds flags every week,
   * and a new flag is stripped until classified rather than failing the bump (fragility U4); a changed condition on
   * a flag still changes the hash.
   */
  readonly omitTrueFlags?: boolean;
}

/** Paths are relative to `t3code/`, ours to the repository root; `entry` is the register entry in docs/upstream-fragility.md. */
export interface WatchedRegion extends RegionSpec {
  readonly file: string;
  readonly hash: string;
  readonly ourFile: string;
  readonly entry: string;
}

export interface WatchedLiteral {
  readonly file: string;
  readonly literal: string;
  readonly ourFile: string;
  readonly entry: string;
}

export interface Fingerprint {
  /** The t3code commit the fixture was last reviewed at. */
  readonly pin: string;
  readonly regions: ReadonlyArray<WatchedRegion>;
  readonly literals: ReadonlyArray<WatchedLiteral>;
}

type Node = { readonly type: string; readonly start: number; readonly end: number; readonly [key: string]: unknown };
type Span = { readonly start: number; readonly end: number };

/** Collapses layout: whitespace runs, whitespace beside punctuation, and trailing commas before a closing bracket. */
export const normalise = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .replace(/ ?([^\w$ ]) ?/g, "$1")
    .replace(/,([)\]}])/g, "$1")
    .trim();

const parse = (source: string): { readonly body: ReadonlyArray<Node>; readonly comments: ReadonlyArray<Span> } => {
  const result = parseSync("region.ts", source, { lang: "ts" });
  return { body: result.program.body as unknown as ReadonlyArray<Node>, comments: result.comments };
};

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string" && typeof (value as { start?: unknown }).start === "number";

const childrenOf = (node: Node): Array<Node> => {
  const children: Array<Node> = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) children.push(...value.filter(isNode));
    else if (isNode(value)) children.push(value);
  }
  return children.toSorted((left, right) => left.start - right.start);
};

const keyName = (key: unknown): string | undefined => {
  if (!isNode(key)) return undefined;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
};

/** The name a node declares or keys, if any. */
const nameOf = (node: Node): string | undefined => {
  switch (node.type) {
    case "VariableDeclarator":
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
    case "TSEnumDeclaration":
      return keyName(node.id);
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition":
    case "TSPropertySignature":
    case "TSMethodSignature":
      return node.computed === true ? undefined : keyName(node.key);
    default:
      return undefined;
  }
};

/** The names a top-level statement declares (through `export`). */
const topLevelNames = (statement: Node): Array<string> => {
  const declaration = (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement) as Node | null;
  if (!isNode(declaration)) return [];
  if (declaration.type === "VariableDeclaration") return (declaration.declarations as Array<Node>).flatMap((declarator) => nameOf(declarator) ?? []);
  return [nameOf(declaration) ?? []].flat();
};

/** The shallowest node below `root` that declares or keys `name`; the first in source order at that depth. */
const findBelow = (root: Node, name: string): Node | undefined => {
  let level = childrenOf(root);
  while (level.length > 0) {
    const found = level.find((node) => nameOf(node) === name);
    if (found !== undefined) return found;
    level = level.flatMap(childrenOf);
  }
  return undefined;
};

const withoutComments = (source: string, comments: ReadonlyArray<Span>, { start, end }: Span): string => {
  let text = "";
  let at = start;
  for (const comment of comments) {
    if (comment.start < at || comment.end > end) continue;
    text += source.slice(at, comment.start);
    at = comment.end;
  }
  return text + source.slice(at, end);
};

const isTrueFlag = (node: Node): boolean =>
  node.type === "Property" && node.computed !== true && node.shorthand !== true && isNode(node.value) && node.value.type === "Literal" && node.value.value === true;

const regionText = (source: string, comments: ReadonlyArray<Span>, node: Node, omitTrueFlags: boolean): string => {
  const object = node.type === "ObjectExpression" ? node : ([node.value, node.init].find((value) => isNode(value) && value.type === "ObjectExpression") as Node | undefined);
  if (!omitTrueFlags || object === undefined) return withoutComments(source, comments, node);
  const kept = (object.properties as Array<Node>).filter((property) => !isTrueFlag(property));
  return (
    withoutComments(source, comments, { start: node.start, end: object.start }) +
    `{${kept.map((property) => withoutComments(source, comments, property)).join(",")}}` +
    withoutComments(source, comments, { start: object.end, end: node.end })
  );
};

/** The region's text without its comments, or undefined when the symbol is gone. */
export const extractRegion = (source: string, region: RegionSpec): string | undefined => {
  const { body, comments } = parse(source);
  if (region.symbol === "*") {
    return body
      .filter((statement) => statement.type !== "ImportDeclaration")
      .map((statement) => withoutComments(source, comments, statement))
      .join("\n");
  }
  const [first, ...rest] = region.symbol.split(".");
  let node = body.find((statement) => topLevelNames(statement).includes(first!));
  for (const name of rest) node = node === undefined ? undefined : findBelow(node, name);
  return node === undefined ? undefined : regionText(source, comments, node, region.omitTrueFlags === true);
};

const hashText = (text: string) => createHash("sha256").update(normalise(text)).digest("hex").slice(0, 16);

/** The hash of the region's normalised text, or undefined when the symbol is gone. */
export const hashRegion = (source: string, region: RegionSpec): string | undefined => {
  const text = extractRegion(source, region);
  return text === undefined ? undefined : hashText(text);
};

/** The source without comments, normalised: what a literal is looked for in. */
const searchableSource = (source: string): string => {
  const { comments } = parse(source);
  return normalise(withoutComments(source, comments, { start: 0, end: source.length }));
};

const tryRead = (read: (file: string) => string, file: string): string | undefined => {
  try {
    return read(file);
  } catch {
    return undefined;
  }
};

const diffHint = (pin: string, file: string) => `Diff since the last review: git -C t3code diff ${pin.slice(0, 12)} -- ${file}`;

type Outcome = { readonly hashes: ReadonlyArray<string | undefined>; readonly gone: ReadonlyArray<string>; readonly missing: ReadonlyArray<string> };

const evaluate = (fingerprint: Fingerprint, read: (file: string) => string): Outcome => {
  const sources = new Map<string, string | undefined>();
  const sourceOf = (file: string) => {
    if (!sources.has(file)) sources.set(file, tryRead(read, file));
    return sources.get(file);
  };
  const gone: Array<string> = [];
  const hashes = fingerprint.regions.map((region) => {
    const source = sourceOf(region.file);
    const hash = source === undefined ? undefined : hashRegion(source, region);
    if (hash === undefined) {
      gone.push(
        `t3code/${region.file} (${region.symbol}) is gone: review ${region.ourFile} (${region.entry}), then point its region in ${FIXTURE_PATH} at where it went and run ${UPDATE_COMMAND}. ${diffHint(fingerprint.pin, region.file)}`,
      );
    }
    return hash;
  });
  const missing = fingerprint.literals.flatMap((watched) => {
    const source = sourceOf(watched.file);
    if (source !== undefined && searchableSource(source).includes(normalise(watched.literal))) return [];
    return [
      `t3code/${watched.file} no longer contains \`${watched.literal}\`: review ${watched.ourFile} (${watched.entry}), then change the literal in ${FIXTURE_PATH} to what t3 sends now. ${diffHint(fingerprint.pin, watched.file)}`,
    ];
  });
  return { hashes, gone, missing };
};

/** One message per watched region that changed or is gone, and per literal t3's source no longer contains. */
export const checkFingerprint = (fingerprint: Fingerprint, read: (file: string) => string): Array<string> => {
  const { hashes, gone, missing } = evaluate(fingerprint, read);
  const changed = fingerprint.regions.flatMap((region, index) => {
    const hash = hashes[index];
    if (hash === undefined || hash === region.hash) return [];
    return [
      `t3code/${region.file} (${region.symbol}) changed: review ${region.ourFile} (${region.entry}), then run ${UPDATE_COMMAND}. ${diffHint(fingerprint.pin, region.file)}`,
    ];
  });
  return [...changed, ...gone, ...missing];
};

/** The fingerprint with each region's current hash, reviewed at `pin`. A gone region or literal is the fixture's to fix by hand. */
export const updateFingerprint = (fingerprint: Fingerprint, read: (file: string) => string, pin: string): Fingerprint => {
  const { hashes, gone, missing } = evaluate(fingerprint, read);
  if (gone.length > 0 || missing.length > 0) throw new Error([...gone, ...missing].join("\n"));
  return { ...fingerprint, pin, regions: fingerprint.regions.map((region, index) => ({ ...region, hash: hashes[index]! })) };
};
