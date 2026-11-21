// The Settings server's shared types (plan D6, D8, D10): what an asked change shows (`ChangeView`, built in render.ts, kept
// in changes.ts, rendered by render.ts and harness/changePage.ts) and why it needs the Change page (`PageReason`). Types
// only, so the modules that build, keep and render a change import each other's shapes without a cycle.
import type { NeedsPage } from "@t3flare/harness-registry";

import type { WorkspaceStatus } from "../agents/workspaceView.ts";

/**
 * Why a change is answered on the Change page alone (plan D6): what its tier says (a secret, a sign-in, skills' text),
 * or `oversize`, text a card would cut.
 */
export type PageReason = NeedsPage | "oversize";

/** One skill an install or update would keep, as previewed at its commit (plan D8, D10). */
export interface ShownSkill {
  readonly name: string;
  readonly description: string;
  /** Its folder in the repo (`""` for the repo's root). */
  readonly path: string;
  readonly files: number;
  readonly bytes: number;
  /** Its folder hash at the commit: the apply refuses another. */
  readonly digest: string;
  /** Its `SKILL.md` text, cut at `SKILL_MD_SHOWN` characters. */
  readonly skillMd: string;
  readonly skillMdCut?: true;
  /** Its files' paths in its folder, at most `PATHS_SHOWN`. */
  readonly paths: ReadonlyArray<string>;
  readonly morePaths?: number;
  /** Why it cannot be installed, as the preview tells: the apply refuses it. */
  readonly problems: ReadonlyArray<string>;
}

/** One thing a change moves, by kind (plan D10's table). */
export type ChangeItem =
  /** A scalar setting, a switch, an Exposure or a class: its name, before and after. */
  | { readonly kind: "scalar"; readonly name: string; readonly before: unknown; readonly after: unknown }
  /** The Variables: names added, changed and removed, with their values. */
  | {
      readonly kind: "variables";
      readonly name: string;
      readonly added: ReadonlyArray<readonly [string, string]>;
      readonly changed: ReadonlyArray<readonly [string, string, string]>;
      readonly removed: ReadonlyArray<readonly [string, string]>;
    }
  /** A `file` or multiline `text` setting: the whole text before and after (the renderer diffs it by line). */
  | { readonly kind: "text"; readonly name: string; readonly before: string; readonly after: string }
  | { readonly kind: "mcp-add"; readonly server: string; readonly url: string; readonly host: string; readonly auth: "none" | "header" | "oauth"; readonly header?: string }
  | { readonly kind: "mcp-remove"; readonly server: string; readonly url?: string }
  /** A header value for an existing header-auth Direct server: typed on the page. */
  | { readonly kind: "header-value"; readonly server: string; readonly header: string; readonly set: boolean }
  | { readonly kind: "sign-in"; readonly server: string; readonly url: string }
  | {
      readonly kind: "skills";
      readonly op: "install" | "update";
      readonly source: string;
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      /** An update's kept commit. */
      readonly from?: string;
      readonly skills: ReadonlyArray<ShownSkill>;
    }
  | { readonly kind: "skill"; readonly op: "enable" | "disable" | "remove"; readonly name: string; readonly repo?: string; readonly commit?: string }
  /**
   * A Purge asked through the Settings server (ADR-0044 §5): the Workspace, its t3 title, the Worktree
   * Workspaces that go with it, each with its status (a `tombstone (kept)` is called out), the deleted threads' Sessions
   * destroyed, and when the Sweep would have purged it (null: never, or not yet known).
   */
  | {
      readonly kind: "purge";
      readonly id: string;
      readonly workspaceKind: "project" | "worktree";
      readonly title: string;
      readonly status: WorkspaceStatus;
      readonly worktrees: ReadonlyArray<{ readonly id: string; readonly status: WorkspaceStatus }>;
      readonly sessions: number;
      readonly purgeDue: number | null;
    };

/** What an Open change is to: a settings entity with a revision, or the Workspaces (a Purge, whose revision is always 0). */
export type ChangeEntity = "harness" | "environment" | "workspaces";

/** What an Open change's card and page render (plan D8's `shown`). */
export interface ChangeView {
  readonly entity: ChangeEntity;
  /** What is changed, in words: "the Environment settings", "the MCP server set", "the Environment skills", "the Workspace acme". */
  readonly subject: string;
  readonly revision: number;
  /** When it applies (plan D17). */
  readonly appliesAt: string;
  /** Why it is asked, from `tierOf`. */
  readonly reasons: ReadonlyArray<string>;
  readonly items: ReadonlyArray<ChangeItem>;
  /** Fixed lines: a Guard turned off, a new server's hint trust. */
  readonly lines: ReadonlyArray<string>;
}
