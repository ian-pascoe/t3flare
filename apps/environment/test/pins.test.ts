// @effect-diagnostics nodeBuiltinImport:off
// The pins an Update moves, named once (ADR-0037; review A1, A5, A6): nightly tags, branch names and what a land deletes,
// the proof a trusted job records, and the CLI list the workflow offers.
import * as fs from "node:fs";
import * as path from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { branchOf, landedBranches, newestNightly, pinOf, pinOfBranch, provenGate, UPDATABLE_CLIS } from "../src/updates/pins.ts";

describe("nightly tags", () => {
  it("orders by date, then run", () => {
    expect(newestNightly(["v0.1.11-nightly.20261117.4851", "v0.1.11-nightly.20261117.999", "v0.1.10-nightly.20261118.1", "v0.2.0", "nightly"])).toBe("v0.1.10-nightly.20261118.1");
    expect(newestNightly(["v0.2.0"])).toBeUndefined();
  });
});

describe("bump branches", () => {
  it("are made and parsed in one place, and only valid pins make one", () => {
    expect(branchOf({ kind: "t3", tag: "v0.1.11-nightly.20261117.4851" })).toBe("bump/v0.1.11-nightly.20261117.4851");
    expect(branchOf({ kind: "cli", cli: "codex", version: "0.169.0" })).toBe("bump/cli-codex-0.169.0");
    expect(pinOfBranch("bump/cli-codex-0.169.0")).toEqual({ kind: "cli", cli: "codex", version: "0.169.0" });
    expect(pinOfBranch("bump/cli-codex-0.169.0-rc.1")).toBeUndefined();
    expect(pinOfBranch("main")).toBeUndefined();
    expect(pinOf({ kind: "cli", cli: "opencode", version: "1.0.0" })).toMatch(/not an updatable CLI/);
    expect(pinOf({ kind: "cli", cli: "codex", version: "1.0.0; rm" })).toMatch(/not an exact version/);
    expect(pinOf({ kind: "t3", tag: "v0.1.11-nightly.20261117.4851" })).toEqual({ kind: "t3", tag: "v0.1.11-nightly.20261117.4851" });
  });

  it("a land deletes only its kind's and CLI's branches at or below its version (A5)", () => {
    const branches = [
      "bump/v0.1.11-nightly.20261117.4825",
      "bump/v0.1.11-nightly.20261117.4851",
      "bump/v0.1.11-nightly.20261118.1",
      "bump/cli-codex-0.167.2",
      "bump/cli-codex-0.169.0",
      "bump/cli-codex-0.170.0",
      "bump/cli-claude-0.100.0",
      "bump/cli-pi-0.0.1-beta",
      "feature/x",
    ];
    expect(landedBranches({ kind: "t3", tag: "v0.1.11-nightly.20261117.4851" }, branches)).toEqual(["bump/v0.1.11-nightly.20261117.4825", "bump/v0.1.11-nightly.20261117.4851"]);
    expect(landedBranches({ kind: "cli", cli: "codex", version: "0.169.0" }, branches)).toEqual(["bump/cli-codex-0.167.2", "bump/cli-codex-0.169.0"]);
  });
});

describe("the proven status (A1)", () => {
  const status = (patch: Record<string, unknown>) => ({ context: "t3flare/proven", state: "success", description: "gate=full", creator: { login: "github-actions[bot]" }, ...patch });

  it("reads the newest t3flare/proven success set by GitHub Actions", () => {
    expect(provenGate([status({})])).toBe("full");
    expect(provenGate([status({ description: "gate=update" }), status({})])).toBe("update");
    expect(provenGate([{ context: "ci", state: "success" }, status({})])).toBe("full");
  });

  it("ignores a status anyone else set, a failure, or a strange gate", () => {
    expect(provenGate([status({ creator: { login: "t3flare[bot]" } })])).toBeUndefined();
    expect(provenGate([status({ state: "failure" })])).toBeUndefined();
    expect(provenGate([status({ description: "gate=anything" })])).toBeUndefined();
    expect(provenGate([])).toBeUndefined();
  });
});

describe("the CLI list", () => {
  it("is cli-bump.yml's choice of CLIs", () => {
    const workflow = parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../.github/workflows/cli-bump.yml"), "utf8")) as { on: { workflow_dispatch: { inputs: { cli: { options: Array<string> } } } } };
    expect(workflow.on.workflow_dispatch.inputs.cli.options).toEqual([...UPDATABLE_CLIS]);
  });
});
