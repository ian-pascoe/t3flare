// The panel's Status line for a Global mise lay-down (SPI-1150, ADR-0032's Global mise config refinement).
import { describe, expect, it } from "vitest";

import { describeGlobalMise, type GlobalMiseReport } from "./globalMise.ts";

const report = (fields: Partial<GlobalMiseReport>): GlobalMiseReport => ({
  workspace: "app",
  runtime: "r1",
  revision: 2,
  sha256: "a".repeat(64),
  bytes: 10,
  source: "environment",
  outcome: "laid",
  install: 0,
  timedOut: false,
  ms: 5,
  at: Date.UTC(2026, 10, 14),
  ...fields,
});

describe("describeGlobalMise", () => {
  it("says why a file was not laid down", () => {
    expect(describeGlobalMise(report({ outcome: "not-laid", install: 1 }))).toContain("not laid down (mise install exit 1)");
    expect(describeGlobalMise(report({ outcome: "not-laid", install: 0 }))).toContain("not laid down (git or gh did not run under it)");
    expect(describeGlobalMise(report({ outcome: "not-laid", install: 124, timedOut: true }))).toContain("not laid down (timed out)");
  });

  it("reads a run with no text (no install) as no Global mise config, never as git or gh failing", () => {
    expect(describeGlobalMise(report({ outcome: "not-laid", install: null, bytes: 0 }))).toBe("app at revision 2: no Global mise config, 2026-11-14T00:00:00.000Z");
    expect(describeGlobalMise(report({ outcome: "none", install: null, bytes: 0 }))).toContain("no Global mise config");
  });
});
