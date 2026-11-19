// @effect-diagnostics nodeBuiltinImport:off
// Which of the typecheck's diagnostics are t3flare's to fix (fragility U10). This program includes t3's server source,
// and checks it under a configuration that differs from t3's own: the DOM lib, and global types other packages declare
// (`@types/react`'s empty `HTMLElement`). t3 checks its own files under its own configuration, so an error in one of them
// that only this program sees is a difference in configuration, not a bug to fix. Errors there are reported but do not
// fail the typecheck. An error in our own files still fails it, including one that t3's change of API causes in them.
// Dependency-free.
import * as path from "node:path";

export interface Diagnostic {
  /** The file as the compiler printed it, relative to the package. */
  readonly file: string;
  readonly category: string;
  /** The diagnostic's first line, and the lines that continue it. */
  readonly text: string;
}

/** The heading the typecheck prints over t3's errors, and how the bump reads their count back from its output. */
export const t3ErrorsHeading = (count: number): string => `${count} error(s) in t3's own files, which only this program's configuration sees (fragility U10); not failing:`;
export const T3_ERRORS_COUNT = /^(\d+) error\(s\) in t3's own files, which only this program's configuration sees/m;

const START = /^(.+?)\((\d+),(\d+)\): (error|warning|suggestion|message) TS\d+: /;

/**
 * The compiler's non-pretty output, as diagnostics, and every other non-empty line it printed. A diagnostic's own
 * continuation lines are indented; an unindented line that starts none (a global `error TS…` with no file, a panic, a
 * refused configuration) is `unparsed`.
 */
export const parseDiagnostics = (output: string): { readonly diagnostics: Array<Diagnostic>; readonly unparsed: Array<string> } => {
  const diagnostics: Array<{ file: string; category: string; lines: Array<string> }> = [];
  const unparsed: Array<string> = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const start = START.exec(line);
    if (start !== null) diagnostics.push({ file: start[1]!, category: start[4]!, lines: [line] });
    else if (/^\s/.test(line) && diagnostics.length > 0) diagnostics.at(-1)!.lines.push(line);
    else unparsed.push(line);
  }
  return { diagnostics: diagnostics.map(({ file, category, lines }) => ({ file, category, text: lines.join("\n") })), unparsed };
};

/** Whether `file` (relative to `cwd`) is inside the t3code submodule at `t3Root`. */
export const isT3File = (file: string, cwd: string, t3Root: string): boolean => {
  const relative = path.relative(t3Root, path.resolve(cwd, file));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export interface TypecheckVerdict {
  readonly ok: boolean;
  /** Every diagnostic in our own files, as printed. */
  readonly ours: ReadonlyArray<Diagnostic>;
  /** Errors in t3's files: reported, not failing. */
  readonly t3Errors: ReadonlyArray<Diagnostic>;
  /** Why the typecheck failed without an error of ours, if it did. */
  readonly reason?: string;
}

/**
 * The typecheck's verdict from the compiler's exit status and output. It passes a non-zero exit only when every error
 * is a diagnostic in t3's files and the compiler printed nothing else: any line it could not read (a global error, a
 * crash), a signal, or a non-zero exit with no error diagnostic fails it. Only a clean exit passes regardless.
 */
export const typecheckVerdict = (status: number | null, output: string, cwd: string, t3Root: string): TypecheckVerdict => {
  const { diagnostics, unparsed } = parseDiagnostics(output);
  const ours = diagnostics.filter((d) => !isT3File(d.file, cwd, t3Root));
  const t3Errors = diagnostics.filter((d) => d.category === "error" && isT3File(d.file, cwd, t3Root));
  const ourErrors = ours.filter((d) => d.category === "error");
  if (ourErrors.length > 0) return { ok: false, ours, t3Errors };
  if (status === 0) return { ok: true, ours, t3Errors };
  if (status === null) return { ok: false, ours, t3Errors, reason: "the compiler was killed by a signal" };
  if (unparsed.length > 0) return { ok: false, ours, t3Errors, reason: `the compiler exited ${status} and printed lines that are not diagnostics: ${unparsed.slice(0, 5).join(" | ")}` };
  if (t3Errors.length === 0) return { ok: false, ours, t3Errors, reason: `the compiler exited ${status} with no error diagnostic` };
  return { ok: true, ours, t3Errors };
};
