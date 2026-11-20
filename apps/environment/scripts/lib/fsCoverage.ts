// The node:fs coverage check (SPI-1301, fragility U9): the build aliases t3's `node:fs` and `node:fs/promises` imports
// to the State directory's shims (ADR-0007), which implement a subset and re-export workerd's own module for the rest
// (`export * from "node:fs"`). A member a t3 module reads that the shim does not implement reaches workerd's in-memory
// file system, not the State directory, and nothing fails: `readSync` did until the t3flare theme (U93). This reads,
// from each aliased module's AST, which members it uses, and names those its shim does not implement and no allowance
// explains. `build.ts` runs it on every t3 module it bundles and fails on any; the report keeps the rest.
import type { parseAst } from "rolldown/parseAst";

type Program = ReturnType<typeof parseAst>;

export type FsModule = "fs" | "fs/promises";

/** The specifiers the build aliases to a State directory shim, by the module they name. */
export const FS_MODULE_OF: Readonly<Record<string, FsModule>> = {
  "node:fs": "fs",
  fs: "fs",
  "node:fs/promises": "fs/promises",
  "fs/promises": "fs/promises",
};

/** One member a module reads: through a namespace or named import (`named`), or a default import (`default`). */
export interface FsUse {
  readonly module: FsModule;
  readonly member: string;
  readonly via: "named" | "default";
}

export interface FsUsage {
  readonly uses: ReadonlyArray<FsUse>;
  /** Uses whose members cannot be read statically: the binding passed as a value, a computed member, a re-export. */
  readonly opaque: ReadonlyArray<string>;
}

/** What a shim implements itself: its own named exports, and its default object's own keys. */
export interface ShimSurface {
  readonly named: ReadonlySet<string>;
  readonly defaultKeys: ReadonlySet<string>;
}

/** Members allowed to come from workerd's own module, each with the reason it is safe there. */
export type FsAllowances = Readonly<Record<FsModule, Readonly<Record<string, string>>>>;

export interface FsCoverage {
  readonly uncovered: ReadonlyArray<{ readonly module: FsModule; readonly member: string; readonly importers: ReadonlyArray<string> }>;
  /** `importer: description` for each opaque use. */
  readonly opaque: ReadonlyArray<string>;
  /** Allowances no bundled module uses any more: stale, to delete. */
  readonly unusedAllowances: ReadonlyArray<string>;
}

type Node = { readonly type: string; readonly [key: string]: unknown };

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** Keys and node types that hold TypeScript types only: a binding read there reads no member at run time. */
const TYPE_KEYS = new Set(["typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeArguments", "implements"]);
const TYPE_NODES = new Set(["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSDeclareFunction", "TSImportType", "TSTypeQuery", "TSQualifiedName"]);

const children = function* (node: Node): Generator<readonly [string, Node]> {
  for (const [key, value] of Object.entries(node)) {
    if (TYPE_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) yield [key, item];
    } else if (isNode(value)) yield [key, value];
  }
};

const sourceOf = (node: Node): string | undefined => {
  const source = node.source;
  return isNode(source) && source.type === "Literal" && typeof source.value === "string" ? source.value : undefined;
};

const nameOf = (node: unknown): string | undefined => {
  if (!isNode(node)) return undefined;
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
};

const label = (module: FsModule) => `node:${module}`;

/** The `node:fs` members a module reads, from its AST (as `this.parse` or `parseAst` give it). */
export const fsUsageOf = (program: Program): FsUsage => {
  const uses: Array<FsUse> = [];
  const opaque: Array<string> = [];
  /** Local name → the module its namespace or default import binds, and how. */
  const bindings = new Map<string, { readonly module: FsModule; readonly via: FsUse["via"] }>();

  for (const statement of program.body as unknown as ReadonlyArray<Node>) {
    const specifier = sourceOf(statement);
    const module = specifier === undefined ? undefined : FS_MODULE_OF[specifier];
    if (module === undefined) continue;
    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type") continue;
      for (const spec of statement.specifiers as ReadonlyArray<Node>) {
        const local = nameOf(spec.local)!;
        if (spec.type === "ImportSpecifier") {
          if (spec.importKind !== "type") uses.push({ module, member: nameOf(spec.imported)!, via: "named" });
        } else bindings.set(local, { module, via: spec.type === "ImportDefaultSpecifier" ? "default" : "named" });
      }
    } else if (statement.type === "ExportNamedDeclaration" && statement.exportKind !== "type") {
      for (const spec of statement.specifiers as ReadonlyArray<Node>) uses.push({ module, member: nameOf(spec.local)!, via: "named" });
    } else if (statement.type === "ExportAllDeclaration") {
      opaque.push(`export * from "${specifier}"`);
    }
  }

  const visit = (node: Node, parent: Node | undefined, key: string | undefined): void => {
    if (TYPE_NODES.has(node.type) || node.type === "ImportDeclaration") return;
    if (node.type === "ImportExpression") {
      const specifier = sourceOf(node);
      if (specifier !== undefined && FS_MODULE_OF[specifier] !== undefined) opaque.push(`import("${specifier}")`);
    }
    if (node.type === "MemberExpression" && isNode(node.object) && node.object.type === "Identifier") {
      const binding = bindings.get(node.object.name as string);
      if (binding !== undefined) {
        const member = node.computed ? undefined : nameOf(node.property);
        if (member === undefined) {
          opaque.push(`${node.object.name as string} (${label(binding.module)}) read with a computed member`);
        } else {
          uses.push({ module: binding.module, member, via: binding.via });
          // `NodeFS.promises.readFile`: a member of node:fs/promises, reached through node:fs.
          if (binding.module === "fs" && member === "promises" && parent?.type === "MemberExpression" && key === "object" && !parent.computed) {
            const inner = nameOf(parent.property);
            if (inner !== undefined) uses.push({ module: "fs/promises", member: inner, via: "named" });
          }
        }
        return;
      }
    }
    if (node.type === "Identifier" && bindings.has(node.name as string)) {
      // A key or a non-computed member name is not a read of the binding.
      const isKey = (parent?.type === "MemberExpression" && key === "property" && !parent.computed) || (parent?.type === "Property" && key === "key" && !parent.computed && !parent.shorthand);
      if (!isKey) opaque.push(`${node.name as string} (${label(bindings.get(node.name as string)!.module)}) used as a value`);
      return;
    }
    for (const [childKey, child] of children(node)) visit(child, node, childKey);
  };
  visit(program as unknown as Node, undefined, undefined);
  return { uses, opaque };
};

/** What a shim implements itself, from its AST: everything but what `export *` passes through. */
export const shimSurfaceOf = (program: Program): ShimSurface => {
  const named = new Set<string>();
  const defaultKeys = new Set<string>();
  for (const statement of program.body as unknown as ReadonlyArray<Node>) {
    if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement.declaration;
      if (isNode(declaration)) {
        if (declaration.type === "VariableDeclaration") {
          for (const declarator of declaration.declarations as ReadonlyArray<Node>) {
            const name = nameOf(declarator.id);
            if (name !== undefined) named.add(name);
          }
        } else {
          const name = nameOf(declaration.id);
          if (name !== undefined) named.add(name);
        }
      }
      for (const spec of (statement.specifiers ?? []) as ReadonlyArray<Node>) named.add(nameOf(spec.exported)!);
    } else if (statement.type === "ExportDefaultDeclaration" && isNode(statement.declaration) && statement.declaration.type === "ObjectExpression") {
      for (const property of statement.declaration.properties as ReadonlyArray<Node>) {
        if (property.type !== "Property" || property.computed) continue;
        const name = nameOf(property.key);
        if (name !== undefined) defaultKeys.add(name);
      }
    }
  }
  return { named, defaultKeys };
};

/** Each use no shim implements and no allowance explains, by member, with the modules that read it. */
export const fsCoverage = (
  modules: ReadonlyArray<{ readonly importer: string; readonly usage: FsUsage }>,
  surfaces: Readonly<Record<FsModule, ShimSurface>>,
  allowances: FsAllowances,
): FsCoverage => {
  const uncovered = new Map<string, { module: FsModule; member: string; importers: Set<string> }>();
  const allowedAndUsed = new Set<string>();
  const opaque: Array<string> = [];
  for (const { importer, usage } of modules) {
    for (const description of usage.opaque) opaque.push(`${importer}: ${description}`);
    for (const { module, member, via } of usage.uses) {
      const surface = surfaces[module];
      if ((via === "default" ? surface.defaultKeys : surface.named).has(member)) continue;
      const key = `${module}.${member}`;
      if (Object.hasOwn(allowances[module], member)) {
        allowedAndUsed.add(key);
        continue;
      }
      const entry = uncovered.get(key) ?? { module, member, importers: new Set<string>() };
      entry.importers.add(importer);
      uncovered.set(key, entry);
    }
  }
  const byKey = (a: string, b: string) => a.localeCompare(b);
  return {
    uncovered: [...uncovered.entries()]
      .toSorted(([a], [b]) => byKey(a, b))
      .map(([, { module, member, importers }]) => ({ module, member, importers: [...importers].toSorted(byKey) })),
    opaque,
    unusedAllowances: (Object.entries(allowances) as Array<[FsModule, Readonly<Record<string, string>>]>)
      .flatMap(([module, members]) => Object.keys(members).map((member) => `${module}.${member}`))
      .filter((key) => !allowedAndUsed.has(key))
      .toSorted(byKey),
  };
};
