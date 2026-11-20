// @effect-diagnostics nodeBuiltinImport:off
// The upstream fingerprint (SPI-1011, fragility T2). Some of our files restate or emulate t3 code that typecheck
// cannot watch: composition.ts restates server.ts's layer graph, terminal/layer.ts restates TerminalManager.make, the
// stale reads match t3's git argv, the gh emulation answers t3's auth schema. The fixture
// (test/fixtures/upstream-fingerprint.json) ties each to a hash of t3's region, or to a literal that must still appear
// in t3's source, so that a change upstream fails `pnpm run check` until our file is reviewed. In the bump the check
// only reports, and the land check refuses to land the pin by itself (ADR-0037's SPI-1011 refinement).
//
// A region is a file and a symbol: a top-level declaration's name, a dotted path into its body (`make.capabilities`
// is the first `capabilities` declared or keyed anywhere inside `make`, shallowest first), or `*` for every top-level
// statement but the imports. Its text, without comments, is normalised so a reflow alone does not change its hash.
import { createHash } from "node:crypto";

import { parseSync } from "rolldown/utils";

import { FIXTURE_PATH, type Finding, type Fingerprint, type RegionSpec, UPDATE_COMMAND, type WatchedRegion, watchedFiles } from "./upstreamFingerprintFixture.ts";

export * from "./upstreamFingerprintFixture.ts";

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

/** A t3 file's text, by path under `t3code/`. */
type Read = (file: string) => string;
/** A t3 file's git blob id at the pin (`gitBlobOf`), undefined when it is not there. */
type BlobOf = (file: string) => string | undefined;

/** The one place each kind of finding is put in words. */
export const findingMessage = (finding: Finding, reviewedCommit: string): string => {
  const diff = `Diff since the last review: git -C t3code diff ${reviewedCommit.slice(0, 12)} -- ${finding.file}`;
  if (finding.kind === "moved") {
    return `t3code/${finding.file} changed outside the watched regions: nothing of ours to review there, but the land check compares whole files, so run ${UPDATE_COMMAND}. ${diff}`;
  }
  const review = `review ${finding.ourFile} (${finding.entry})`;
  switch (finding.kind) {
    case "changed":
      return `t3code/${finding.file} (${finding.symbol}) changed: ${review}, then run ${UPDATE_COMMAND}. ${diff}`;
    case "gone":
      return `t3code/${finding.file} (${finding.symbol}) is gone: ${review}, then point its region in ${FIXTURE_PATH} at where it went and run ${UPDATE_COMMAND}. ${diff}`;
    case "missing":
      return `t3code/${finding.file} no longer contains \`${finding.literal}\`: ${review}, then change the literal in ${FIXTURE_PATH} to what t3 sends now. ${diff}`;
  }
};

const regionFinding = (kind: "changed" | "gone", { file, symbol, ourFile, entry }: WatchedRegion): Finding => ({ kind, file, symbol, ourFile, entry });

/** Each region with its current hash (undefined when gone), each watched file's blob id, and every finding. */
const evaluate = (fingerprint: Fingerprint, read: Read, blobOf: BlobOf) => {
  const sources = new Map<string, string | undefined>();
  const sourceOf = (file: string) => {
    if (!sources.has(file)) sources.set(file, tryRead(read, file));
    return sources.get(file);
  };
  const regions = fingerprint.regions.map((region) => {
    const source = sourceOf(region.file);
    return { region, hash: source === undefined ? undefined : hashRegion(source, region) };
  });
  const findings: Array<Finding> = [
    ...regions.flatMap(({ region, hash }) => (hash === undefined ? [regionFinding("gone", region)] : hash === region.hash ? [] : [regionFinding("changed", region)])),
    ...fingerprint.literals.flatMap(({ file, literal, ourFile, entry }): Array<Finding> => {
      const source = sourceOf(file);
      return source !== undefined && searchableSource(source).includes(normalise(literal)) ? [] : [{ kind: "missing", file, literal, ourFile, entry }];
    }),
  ];
  const blobs = Object.fromEntries(watchedFiles(fingerprint).map((file) => [file, blobOf(file)]));
  const named = new Set(findings.map((finding) => finding.file));
  for (const [file, blob] of Object.entries(blobs)) {
    if (!named.has(file) && blob !== fingerprint.files[file]) findings.push({ kind: "moved", file });
  }
  return { regions, blobs, findings };
};

/** Every watched region that changed or is gone, every literal t3's source no longer contains, and every other watched file whose bytes moved. */
export const fingerprintFindings = (fingerprint: Fingerprint, read: Read, blobOf: BlobOf): Array<Finding> => evaluate(fingerprint, read, blobOf).findings;

/** One message per finding. */
export const checkFingerprint = (fingerprint: Fingerprint, read: Read, blobOf: BlobOf): Array<string> =>
  fingerprintFindings(fingerprint, read, blobOf).map((finding) => findingMessage(finding, fingerprint.reviewedCommit));

/**
 * The fingerprint with each region's current hash and each watched file's blob id, reviewed at `reviewedCommit`. A gone
 * region or a missing literal is the fixture's to fix by hand.
 */
export const updateFingerprint = (fingerprint: Fingerprint, read: Read, blobOf: BlobOf, reviewedCommit: string): Fingerprint => {
  const { regions, blobs, findings } = evaluate(fingerprint, read, blobOf);
  const unfixable = findings.filter((finding) => finding.kind === "gone" || finding.kind === "missing");
  if (unfixable.length > 0) throw new Error(unfixable.map((finding) => findingMessage(finding, fingerprint.reviewedCommit)).join("\n"));
  return {
    reviewedCommit,
    regions: regions.map(({ region, hash }) => ({ ...region, hash: hash! })),
    literals: fingerprint.literals,
    files: Object.fromEntries(Object.entries(blobs).map(([file, blob]) => [file, blob ?? ""])),
  };
};
