// What the land workflow checks before it fast-forwards `main` to a proposed pin (ADR-0037; in-app updates plan D4):
// the branch is exactly one commit on `origin/main`, it changes only the files its kind of update may change, and a t3
// bump's gitlink is the upstream tag's commit. `scripts/land-check.ts` gathers the facts with git; this decides.
import { CLI_PIN_FILES } from "./cliPins.ts";

export type LandKind = "t3" | "cli";

/** `scripts/bump.ts`'s PINNED_FILES and the submodule: all a t3 bump commits. */
export const T3_PIN_FILES = ["t3code", "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "mise.toml"] as const;

export const LAND_ALLOWLIST: Record<LandKind, ReadonlyArray<string>> = { t3: T3_PIN_FILES, cli: CLI_PIN_FILES };

export interface LandFacts {
  readonly kind: LandKind;
  /** `git merge-base --is-ancestor origin/main <branch>` passed. */
  readonly mainIsAncestor: boolean;
  /** `git rev-list --count origin/main..<branch>`. */
  readonly commits: number;
  /** `git diff --name-only origin/main <branch>`. */
  readonly files: ReadonlyArray<string>;
  /** A t3 bump: the branch's `t3code` gitlink and the upstream tag's commit. */
  readonly gitlink?: string;
  readonly tagCommit?: string;
}

/** Why the branch may not land, or undefined. */
export const landRefusal = (facts: LandFacts): string | undefined => {
  if (!facts.mainIsAncestor) return "origin/main is not an ancestor of the branch: main moved on, or the branch is not a bump of it";
  if (facts.commits !== 1) return `the branch is ${facts.commits} commits on origin/main, not one`;
  const allowed = new Set(LAND_ALLOWLIST[facts.kind]);
  const outside = facts.files.filter((file) => !allowed.has(file));
  if (outside.length > 0) return `a ${facts.kind} bump may not change ${outside.join(", ")}`;
  if (facts.files.length === 0) return "the branch changes nothing";
  if (facts.kind === "t3") {
    if (facts.gitlink === undefined || facts.tagCommit === undefined || facts.gitlink !== facts.tagCommit) {
      return `the t3code gitlink ${facts.gitlink ?? "?"} is not the tag's commit ${facts.tagCommit ?? "?"}`;
    }
  }
  return undefined;
};
