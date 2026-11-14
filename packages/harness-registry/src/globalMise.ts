// @effect-diagnostics globalDate:off
// The Global mise config's lay-down as the Workspace DO reports it and the panel's Status shows it (SPI-1150,
// ADR-0032's Global mise config refinement): one answer per Container start, sent to the Environment DO, which keeps the last across all Workspaces.
// Imported by both Workers.

/** A text's size and SHA-256: what the audit, the logs and `containerState()` show of a `file` setting, never the text. */
export interface TextDigest {
  readonly bytes: number;
  readonly sha256: string;
}

const utf8 = new TextEncoder();

/** `text`'s size in bytes of UTF-8 and its SHA-256, in hex. */
export const digestOf = async (text: string): Promise<TextDigest> => {
  const bytes = utf8.encode(text);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return { bytes: bytes.length, sha256: [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
};

/**
 * How one lay-down ended: `laid` (the owner's file is mise's global config), `not-laid` (git or gh failed under it, or
 * its install timed out, or there was no text), `exec-failed` (the platform's exec refused or broke; retried) or
 * `deadline` (the Workspace DO stopped waiting; final for that Container).
 */
export type GlobalMiseOutcome = "laid" | "not-laid" | "exec-failed" | "deadline";

const OUTCOMES: ReadonlyArray<GlobalMiseOutcome> = ["laid", "not-laid", "exec-failed", "deadline"];

export interface GlobalMiseReport {
  /** The Workspace's id (t3's path), or null when the Workspace DO does not know it. */
  readonly workspace: string | null;
  /** The Container's runtime id the run was for. */
  readonly runtime: string;
  readonly revision: number;
  readonly sha256: string;
  readonly bytes: number;
  /** Where the start's settings came from (`takeEnvironment`). */
  readonly source: "environment" | "kept" | "default";
  readonly outcome: GlobalMiseOutcome;
  /** `mise install`'s exit, or null when it did not run. */
  readonly install: number | null;
  /** The install or a check was cut off by its timeout (exit 124, or 137 after the KILL). */
  readonly timedOut: boolean;
  readonly ms: number;
  readonly at: number;
}

const SOURCES = ["environment", "kept", "default"];

/** `value` as a report, or undefined when it is not one (the Environment DO takes it from another Worker). */
export const globalMiseReport = (value: unknown): GlobalMiseReport | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const report = value as Record<string, unknown>;
  const shortText = (field: unknown, max: number) => typeof field === "string" && field.length <= max;
  const count = (field: unknown) => typeof field === "number" && Number.isInteger(field) && field >= 0;
  const ok =
    (report.workspace === null || shortText(report.workspace, 1024)) &&
    shortText(report.runtime, 200) &&
    count(report.revision) &&
    typeof report.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(report.sha256) &&
    count(report.bytes) &&
    SOURCES.includes(report.source as string) &&
    OUTCOMES.includes(report.outcome as GlobalMiseOutcome) &&
    (report.install === null || (typeof report.install === "number" && Number.isInteger(report.install))) &&
    typeof report.timedOut === "boolean" &&
    count(report.ms) &&
    count(report.at);
  if (!ok) return undefined;
  return {
    workspace: report.workspace as string | null,
    runtime: report.runtime as string,
    revision: report.revision as number,
    sha256: report.sha256 as string,
    bytes: report.bytes as number,
    source: report.source as GlobalMiseReport["source"],
    outcome: report.outcome as GlobalMiseOutcome,
    install: report.install as number | null,
    timedOut: report.timedOut as boolean,
    ms: report.ms as number,
    at: report.at as number,
  };
};

/** One line for the panel's Status. */
export const describeGlobalMise = (report: GlobalMiseReport): string => {
  const what =
    report.outcome === "laid"
      ? `laid down${report.install === 0 || report.install === null ? "" : ` (mise install exit ${report.install})`}`
      : report.outcome === "not-laid"
        ? `not laid down (${report.timedOut ? "timed out" : report.install === null ? "no text" : report.install === 0 ? "git or gh did not run under it" : `mise install exit ${report.install}`})`
        : report.outcome === "exec-failed"
          ? "not laid down (the Container's exec failed; tried again)"
          : "not laid down (no answer within the deadline)";
  return `${report.workspace ?? "a Workspace"} at revision ${report.revision}: ${what}, ${new Date(report.at).toISOString()}`;
};
