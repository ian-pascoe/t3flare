// The land workflow's checks (ADR-0037; in-app updates plan D4): one commit on origin/main, only the files its kind of
// update may change, and a t3 bump's gitlink at the tag's commit.
import { describe, expect, it } from "vitest";

import { landRefusal, type LandFacts } from "../scripts/lib/land.ts";

const SHA = "cd9c39fe3c25ad71657cc0b8631b6de76775261e";
const t3 = (patch: Partial<LandFacts> = {}): LandFacts => ({
  kind: "t3",
  mainIsAncestor: true,
  commits: 1,
  files: ["mise.toml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "t3code"],
  gitlink: SHA,
  tagCommit: SHA,
  ...patch,
});

describe("landing a proposed pin", () => {
  it("lands a t3 bump of one commit, its pinned files, at the tag", () => {
    expect(landRefusal(t3())).toBeUndefined();
  });

  it("refuses a branch main is not an ancestor of, or more than one commit", () => {
    expect(landRefusal(t3({ mainIsAncestor: false }))).toMatch(/not an ancestor/);
    expect(landRefusal(t3({ commits: 2 }))).toMatch(/2 commits/);
    expect(landRefusal(t3({ commits: 0 }))).toMatch(/0 commits/);
  });

  it("refuses a file outside the kind's allowlist", () => {
    expect(landRefusal(t3({ files: ["t3code", ".github/workflows/deploy-prod.yml"] }))).toMatch(/may not change \.github\/workflows\/deploy-prod\.yml/);
    expect(landRefusal(t3({ kind: "cli", files: ["t3code"] }))).toMatch(/cli bump may not change t3code/);
  });

  it("refuses a t3 gitlink that is not the tag's commit", () => {
    expect(landRefusal(t3({ gitlink: "0".repeat(40) }))).toMatch(/not the tag's commit/);
    expect(landRefusal(t3({ tagCommit: undefined } as never))).toMatch(/not the tag's commit/);
  });

  it("lands a CLI bump of the image's pins", () => {
    expect(landRefusal({ kind: "cli", mainIsAncestor: true, commits: 1, files: ["apps/sandbox-image/image/Dockerfile", "apps/sandbox-image/src/clis.ts"] })).toBeUndefined();
  });
});
