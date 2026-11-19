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

const START = /^(.+?)\((\d+),(\d+)\): (error|warning|suggestion|message) TS\d+: /;

/** The compiler's non-pretty output, as diagnostics; lines before the first (none, normally) are dropped. */
export const parseDiagnostics = (output: string): Array<Diagnostic> => {
  const diagnostics: Array<{ file: string; category: string; lines: Array<string> }> = [];
  for (const line of output.split(/\r?\n/)) {
    const start = START.exec(line);
    if (start !== null) diagnostics.push({ file: start[1]!, category: start[4]!, lines: [line] });
    else if (line.trim() !== "" && diagnostics.length > 0) diagnostics.at(-1)!.lines.push(line);
  }
  return diagnostics.map(({ file, category, lines }) => ({ file, category, text: lines.join("\n") }));
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
 * The typecheck's verdict from the compiler's exit status and output. A non-zero exit with no error diagnostic at all is
 * a failure (the compiler crashed or refused its configuration); one whose errors are all in t3's files is a pass.
 */
export const typecheckVerdict = (status: number | null, output: string, cwd: string, t3Root: string): TypecheckVerdict => {
  const diagnostics = parseDiagnostics(output);
  const ours = diagnostics.filter((d) => !isT3File(d.file, cwd, t3Root));
  const t3Errors = diagnostics.filter((d) => d.category === "error" && isT3File(d.file, cwd, t3Root));
  const ourErrors = ours.filter((d) => d.category === "error");
  if (ourErrors.length > 0) return { ok: false, ours, t3Errors };
  if (status !== 0 && t3Errors.length === 0) return { ok: false, ours, t3Errors, reason: `the compiler exited ${String(status)} with no error diagnostic` };
  return { ok: true, ours, t3Errors };
};
