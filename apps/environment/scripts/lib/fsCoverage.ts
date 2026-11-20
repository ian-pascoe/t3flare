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

/** One aliased module's node:fs reads. */
export interface FsModuleUsage {
  readonly importer: string;
  readonly usage: FsUsage;
}

export interface FsCoverage {
  readonly uncovered: ReadonlyArray<{ readonly module: FsModule; readonly member: string; readonly importers: ReadonlyArray<string> }>;
  /** `importer: description` for each opaque use. */
  readonly opaque: ReadonlyArray<string>;
  /** Allowances some bundled module uses, as `module.member`. */
  readonly allowed: ReadonlyArray<string>;
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
const keyOf = (module: FsModule, member: string) => `${module}.${member}`;

/** A source of members: a namespace or default binding, node:fs's `promises`, or an awaited dynamic import. */
type Source = { readonly module: FsModule; readonly via: FsUse["via"]; readonly name: string };

/** The `node:fs` members a module reads, from its AST (as `this.parse` or `parseAst` give it). */
export const fsUsageOf = (program: Program): FsUsage => {
  const uses: Array<FsUse> = [];
  const opaque: Array<string> = [];
  /** Local name → the module its namespace, default or `promises` import binds, and how. */
  const bindings = new Map<string, Omit<Source, "name">>();

  for (const statement of program.body as unknown as ReadonlyArray<Node>) {
    const specifier = sourceOf(statement);
    const module = specifier === undefined ? undefined : FS_MODULE_OF[specifier];
    if (module === undefined) continue;
    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type") continue;
      for (const spec of statement.specifiers as ReadonlyArray<Node>) {
        const local = nameOf(spec.local)!;
        if (spec.type === "ImportSpecifier") {
          if (spec.importKind === "type") continue;
          const member = nameOf(spec.imported)!;
          uses.push({ module, member, via: "named" });
          // `import { promises as fsp } from "node:fs"`: fsp's members are node:fs/promises's.
          if (module === "fs" && member === "promises") bindings.set(local, { module: "fs/promises", via: "named" });
        } else bindings.set(local, { module, via: spec.type === "ImportDefaultSpecifier" ? "default" : "named" });
      }
    } else if (statement.type === "ExportNamedDeclaration" && statement.exportKind !== "type") {
      for (const spec of statement.specifiers as ReadonlyArray<Node>) {
        const member = nameOf(spec.local)!;
        uses.push({ module, member, via: "named" });
        if (module === "fs" && member === "promises") opaque.push(`export { promises } from "${specifier}"`);
      }
    } else if (statement.type === "ExportAllDeclaration") {
      opaque.push(`export * from "${specifier}"`);
    }
  }

  /** Records a read of `member` from `source`; node:fs's `promises` is itself a source, of node:fs/promises. */
  const read = (source: Source, member: string): Source | undefined => {
    uses.push({ module: source.module, member, via: source.via });
    return source.module === "fs" && member === "promises" ? { module: "fs/promises", via: "named", name: `${source.name}.promises` } : undefined;
  };

  /** `const { a, b: c, promises: { d } } = source`: each key is a member read. */
  const destructure = (source: Source, pattern: Node): void => {
    for (const property of pattern.properties as ReadonlyArray<Node>) {
      const member = property.type === "Property" && !property.computed ? nameOf(property.key) : undefined;
      if (member === undefined) {
        opaque.push(`${source.name} (${label(source.module)}) destructured with ${property.type === "RestElement" ? "a rest element" : "a computed key"}`);
        continue;
      }
      const inner = read(source, member);
      if (inner === undefined) continue;
      // `{ promises: { readFile } }` reads node:fs/promises's members; `{ promises }` or `{ promises: fsp }` binds them opaquely.
      if (isNode(property.value) && property.value.type === "ObjectPattern") destructure(inner, property.value);
      else opaque.push(`${inner.name} (${label(inner.module)}) destructured into a binding`);
    }
  };

  /** The source an expression names, if it names one: a binding, `binding.promises`, or `await import("node:fs")`. */
  const sourceAt = (node: Node): { readonly source: Source; readonly read?: string } | undefined => {
    if (node.type === "Identifier") {
      const binding = bindings.get(node.name as string);
      return binding === undefined ? undefined : { source: { ...binding, name: node.name as string } };
    }
    if (node.type === "MemberExpression" && !node.computed && isNode(node.object) && node.object.type === "Identifier") {
      const binding = bindings.get(node.object.name as string);
      const member = nameOf(node.property);
      if (binding === undefined || binding.module !== "fs" || member !== "promises") return undefined;
      return { source: { ...binding, name: node.object.name as string }, read: member };
    }
    if (node.type === "AwaitExpression" && isNode(node.argument) && node.argument.type === "ImportExpression") {
      const specifier = sourceOf(node.argument);
      const module = specifier === undefined ? undefined : FS_MODULE_OF[specifier];
      return module === undefined ? undefined : { source: { module, via: "named", name: `import("${specifier}")` } };
    }
    return undefined;
  };

  const visit = (node: Node, parent: Node | undefined, key: string | undefined): void => {
    if (TYPE_NODES.has(node.type) || node.type === "ImportDeclaration") return;
    if (node.type === "VariableDeclarator" && isNode(node.id) && node.id.type === "ObjectPattern" && isNode(node.init)) {
      const found = sourceAt(node.init);
      if (found !== undefined) {
        const source = found.read === undefined ? found.source : read(found.source, found.read)!;
        destructure(source, node.id);
        visit(node.id, node, "id");
        return;
      }
    }
    if (node.type === "ImportExpression") {
      const specifier = sourceOf(node);
      if (specifier !== undefined && FS_MODULE_OF[specifier] !== undefined) opaque.push(`import("${specifier}")`);
    }
    if (node.type === "MemberExpression" && isNode(node.object) && node.object.type === "Identifier") {
      const binding = bindings.get(node.object.name as string);
      if (binding !== undefined) {
        const source = { ...binding, name: node.object.name as string };
        const member = node.computed ? undefined : nameOf(node.property);
        if (member === undefined) {
          opaque.push(`${source.name} (${label(source.module)}) read with a computed member`);
        } else {
          const inner = read(source, member);
          // `NodeFS.promises.readFile` reads node:fs/promises's readFile; `NodeFS.promises` anywhere else is opaque.
          if (inner !== undefined) {
            const innerMember = parent?.type === "MemberExpression" && key === "object" && !parent.computed ? nameOf(parent.property) : undefined;
            if (innerMember === undefined) opaque.push(`${inner.name} (${label(inner.module)}) used as a value`);
            else read(inner, innerMember);
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
export const fsCoverage = (modules: ReadonlyArray<FsModuleUsage>, surfaces: Readonly<Record<FsModule, ShimSurface>>, allowances: FsAllowances): FsCoverage => {
  const uncovered = new Map<string, { module: FsModule; member: string; importers: Set<string> }>();
  const allowed = new Set<string>();
  const opaque: Array<string> = [];
  for (const { importer, usage } of modules) {
    for (const description of usage.opaque) opaque.push(`${importer}: ${description}`);
    for (const { module, member, via } of usage.uses) {
      const surface = surfaces[module];
      if ((via === "default" ? surface.defaultKeys : surface.named).has(member)) continue;
      const key = keyOf(module, member);
      if (Object.hasOwn(allowances[module], member)) {
        allowed.add(key);
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
    allowed: [...allowed].toSorted(byKey),
    unusedAllowances: (Object.entries(allowances) as Array<[FsModule, Readonly<Record<string, string>>]>)
      .flatMap(([module, members]) => Object.keys(members).map((member) => keyOf(module, member)))
      .filter((key) => !allowed.has(key))
      .toSorted(byKey),
  };
};

/** The coverage check's failure, naming what to do, or undefined when every read is implemented or allowed. */
export const fsCoverageFailure = (coverage: FsCoverage): string | undefined => {
  if (coverage.uncovered.length === 0 && coverage.opaque.length === 0) return undefined;
  const lines = ["t3flare: t3 reads node:fs members the State directory's shims may not implement, so they would reach workerd's own file system (SPI-1301):"];
  if (coverage.uncovered.length > 0) {
    lines.push(
      ...coverage.uncovered.map(({ module, member, importers }) => `  ${label(module)}.${member}, read by ${importers.join(", ")}`),
      "Implement each in src/shims/node-fs.ts or node-fs-promises.ts, or allow it in build.ts's FS_ALLOWANCES with the reason it is safe.",
    );
  }
  if (coverage.opaque.length > 0) {
    lines.push(
      ...coverage.opaque.map((description) => `  ${description}`),
      "Their members cannot be read statically: rewrite each (a Patch, ADR-0001) to read members by name (a namespace or named import, member reads, destructuring), or teach scripts/lib/fsCoverage.ts the form.",
    );
  }
  return lines.join("\n");
};
