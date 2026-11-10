// git's patch and numstat text, made in the Workspace DO (step 2a plan, M3: checkpoint diffs without the Container;
// ADR-0009): what `git diff --patch|--numstat -z --no-color --no-ext-diff --no-textconv --src-prefix=a/
// --dst-prefix=b/ -c diff.suppressBlankEmpty=false` prints for a list of changed files, with git's headers (new and
// deleted files, modes, exact renames, binary files), 7-character abbreviated ids, its hunk headers with the default
// function-name line, and its `\ No newline at end of file` marks. Line matching is jsdiff's Myers diff; git's xdiff
// (also Myers, with the indent heuristic) can place an ambiguous change elsewhere. The fidelity tests
// (`test/gitPatch.test.ts`) compare this with real git byte for byte. Pure: no I/O.
//
// Text is handled as Latin-1 strings (one character per byte) so every byte survives, and turned into UTF-8 text at
// the end, as the router hands git's stdout to t3.
import { structuredPatch } from "diff";

/** One side of a changed file: absent (`null`), or its mode, blob id and bytes. */
export interface FileSide {
  readonly mode: string;
  readonly oid: string;
  readonly bytes: Uint8Array;
}

/** One changed file, as git's diff queue holds it. */
export interface FileChange {
  /** The path on the old side (the source of a rename), or the path. */
  readonly oldPath: string;
  readonly newPath: string;
  readonly old: FileSide | null;
  readonly new: FileSide | null;
}

export interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
}

const ZERO = "0000000";
const CONTEXT = 3;
/** git's buffer for the function-name line of a hunk header (`struct func_line`). */
const FUNC_LINE_BYTES = 80;
/** git's rule for a binary file: a NUL in its first 8,000 bytes (`buffer_is_binary`). */
const BINARY_SNIFF = 8000;

/** git's empty blob: never a rename source (git skips empty files in rename detection). */
export const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

export const latin1 = (bytes: Uint8Array): string => {
  let out = "";
  for (let at = 0; at < bytes.length; at += 8192) out += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return out;
};

const fromLatin1 = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let at = 0; at < text.length; at++) out[at] = text.charCodeAt(at) & 0xff;
  return out;
};

/** The bytes of `text` (Latin-1) as UTF-8 text, as git's stdout reaches t3. */
export const asOutput = (text: string): string => new TextDecoder().decode(fromLatin1(text));

export const isBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, BINARY_SNIFF).includes(0);

const abbrev = (oid: string) => oid.slice(0, 7);

const ESCAPES: Readonly<Record<number, string>> = { 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r", 34: '"', 92: "\\" };

/** git's C-style quoting of a path that needs it (`core.quotePath`, on by default), as Latin-1 text. */
export const quotePath = (path: string): string => {
  const bytes = new TextEncoder().encode(path);
  let needs = false;
  let body = "";
  for (const byte of bytes) {
    const escape = ESCAPES[byte];
    if (escape !== undefined) {
      needs = true;
      body += `\\${escape}`;
    } else if (byte < 0x20 || byte >= 0x7f) {
      needs = true;
      body += `\\${byte.toString(8).padStart(3, "0")}`;
    } else body += String.fromCharCode(byte);
  }
  return needs ? `"${body}"` : body;
};

/** `prefix` + `path`, quoted as a whole when the path needs it, as git prints `a/…`. */
const prefixed = (prefix: string, path: string): string => {
  const quoted = quotePath(path);
  return quoted.startsWith('"') ? `"${prefix}${quoted.slice(1)}` : `${prefix}${quoted}`;
};

/** Lines of `text` with their newlines, as xdiff records them. */
const records = (text: string): Array<string> => {
  const out: Array<string> = [];
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    if (text.charCodeAt(at) === 10) {
      out.push(text.slice(start, at + 1));
      start = at + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
};

const isSpace = (code: number) => code === 32 || (code >= 9 && code <= 13);
const isAlpha = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/** git's default function-name line (`def_ff`): a line that starts with a letter, `_` or `$`, cut and trimmed. */
const funcLine = (record: string): string | undefined => {
  if (record.length === 0) return undefined;
  const first = record.charCodeAt(0);
  if (!(isAlpha(first) || first === 95 || first === 36)) return undefined;
  let len = Math.min(record.length, FUNC_LINE_BYTES);
  while (len > 0 && isSpace(record.charCodeAt(len - 1))) len--;
  return record.slice(0, len);
};

/** The function-name line for a hunk whose first old line is `first` (0-based): the nearest one above it. */
const funcAbove = (oldRecords: ReadonlyArray<string>, first: number): string | undefined => {
  for (let line = first - 1; line >= 0; line--) {
    const found = funcLine(oldRecords[line] ?? "");
    if (found !== undefined) return found;
  }
  return undefined;
};

const range = (start: number, count: number): string => (count === 1 ? `${start}` : `${start},${count}`);

/** The hunks of a text change, as git prints them (`@@ … @@ func` and the lines). */
const hunksOf = (oldText: string, newText: string): string => {
  const patch = structuredPatch("a", "b", oldText, newText, undefined, undefined, { context: CONTEXT });
  const oldRecords = records(oldText);
  let out = "";
  for (const hunk of patch.hunks) {
    const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart;
    const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart;
    const func = funcAbove(oldRecords, hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1);
    out += `@@ -${range(oldStart, hunk.oldLines)} +${range(newStart, hunk.newLines)} @@${func === undefined ? "" : ` ${func}`}\n`;
    for (const line of hunk.lines) out += line.startsWith("\\") ? "\\ No newline at end of file\n" : `${line}\n`;
  }
  return out;
};

/** One file's section of `git diff --patch`, as Latin-1 text. */
export const filePatch = (change: FileChange): string => {
  const { old: before, new: after } = change;
  let out = `diff --git ${prefixed("a/", change.oldPath)} ${prefixed("b/", change.newPath)}\n`;
  const renamed = change.oldPath !== change.newPath && before !== null && after !== null;
  if (before === null && after !== null) out += `new file mode ${after.mode}\n`;
  else if (after === null && before !== null) out += `deleted file mode ${before.mode}\n`;
  else if (before !== null && after !== null && before.mode !== after.mode) out += `old mode ${before.mode}\nnew mode ${after.mode}\n`;
  // Only exact renames are paired here (`treeChanges`).
  if (renamed) out += `similarity index 100%\nrename from ${quotePath(change.oldPath)}\nrename to ${quotePath(change.newPath)}\n`;
  if (before !== null && after !== null && before.oid === after.oid) return out;
  const oldOid = before === null ? ZERO : abbrev(before.oid);
  const newOid = after === null ? ZERO : abbrev(after.oid);
  const modeSuffix = before !== null && after !== null && before.mode === after.mode ? ` ${before.mode}` : "";
  out += `index ${oldOid}..${newOid}${modeSuffix}\n`;
  const oldBytes = before?.bytes ?? new Uint8Array(0);
  const newBytes = after?.bytes ?? new Uint8Array(0);
  const oldName = before === null ? "/dev/null" : prefixed("a/", change.oldPath);
  const newName = after === null ? "/dev/null" : prefixed("b/", change.newPath);
  if (isBinary(oldBytes) || isBinary(newBytes)) return `${out}Binary files ${oldName} and ${newName} differ\n`;
  // An empty file added or deleted has no hunk, and git prints no file lines for it.
  if (oldBytes.length === 0 && newBytes.length === 0) return out;
  // git ends a file line whose name has a space with a tab (`diff.c`, `name_a_tab`).
  const tab = (name: string) => (name.includes(" ") ? "\t" : "");
  return `${out}--- ${oldName}${tab(oldName)}\n+++ ${newName}${tab(newName)}\n${hunksOf(latin1(oldBytes), latin1(newBytes))}`;
};

/** Lines added and deleted, as `--numstat` counts them; null for a binary file. */
export const lineCounts = (change: FileChange): { readonly added: number; readonly deleted: number } | null => {
  const oldBytes = change.old?.bytes ?? new Uint8Array(0);
  const newBytes = change.new?.bytes ?? new Uint8Array(0);
  if (isBinary(oldBytes) || isBinary(newBytes)) return null;
  if (change.old !== null && change.new !== null && change.old.oid === change.new.oid) return { added: 0, deleted: 0 };
  const patch = structuredPatch("a", "b", latin1(oldBytes), latin1(newBytes), undefined, undefined, { context: 0 });
  let added = 0;
  let deleted = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) deleted++;
    }
  }
  return { added, deleted };
};

/** One file's record of `git diff --numstat -z`, as Latin-1 text. */
export const fileNumstat = (change: FileChange): string => {
  const counts = lineCounts(change);
  const head = counts === null ? "-\t-\t" : `${counts.added}\t${counts.deleted}\t`;
  const path = (value: string) => latin1(new TextEncoder().encode(value));
  return change.oldPath !== change.newPath && change.old !== null && change.new !== null
    ? `${head}\0${path(change.oldPath)}\0${path(change.newPath)}\0`
    : `${head}${path(change.newPath)}\0`;
};

/** git's path order (`strcmp` on the bytes). */
export const byPath = (left: string, right: string): number => {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  for (let at = 0; at < Math.min(a.length, b.length); at++) if (a[at] !== b[at]) return a[at]! - b[at]!;
  return a.length - b.length;
};

export interface TreeChange {
  readonly oldPath: string;
  readonly newPath: string;
  readonly old: TreeEntry | null;
  readonly new: TreeEntry | null;
}

/**
 * The changes between two flat trees (`path → {mode, oid}`), in git's order, with exact renames paired as git's rename
 * detection pairs them (a deleted file and an added file with the same blob and mode). Inexact renames stay a delete and
 * an add: git would pair a similar file, which is why the Container's git makes the diff while it runs.
 */
export const treeChanges = (from: ReadonlyMap<string, TreeEntry>, to: ReadonlyMap<string, TreeEntry>): Array<TreeChange> => {
  const paths = [...new Set([...from.keys(), ...to.keys()])].toSorted(byPath);
  const raw: Array<TreeChange> = [];
  for (const path of paths) {
    const before = from.get(path) ?? null;
    const after = to.get(path) ?? null;
    if (before !== null && after !== null && before.oid === after.oid && before.mode === after.mode) continue;
    // A file that became a symlink (or back) is a delete and an add in git.
    if (before !== null && after !== null && (before.mode === "120000") !== (after.mode === "120000")) {
      raw.push({ oldPath: path, newPath: path, old: before, new: null }, { oldPath: path, newPath: path, old: null, new: after });
      continue;
    }
    raw.push({ oldPath: path, newPath: path, old: before, new: after });
  }
  const deleted = raw.filter((change) => change.new === null && change.old !== null && change.old.oid !== EMPTY_BLOB);
  const used = new Set<TreeChange>();
  const paired: Array<TreeChange> = [];
  for (const change of raw) {
    if (change.old === null && change.new !== null) {
      const added = change.new;
      const source = deleted.find((candidate) => !used.has(candidate) && candidate.old!.oid === added.oid && candidate.old!.mode === added.mode);
      if (source !== undefined) {
        used.add(source);
        paired.push({ oldPath: source.oldPath, newPath: change.newPath, old: source.old, new: added });
        continue;
      }
    }
    paired.push(change);
  }
  return paired.filter((change) => !used.has(change));
};
