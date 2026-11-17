// The Container token's permissions (ADR-0013; back to stock, owner 2026-11-12): the Workspace's one repo, code
// writable from the Container's own git, and `workflows` only for a Workspace the owner opted in (K7).
import { describe, expect, it } from "vitest";

import { containerGitHubPermissions, ENVIRONMENT_GITHUB_PERMISSIONS, GITHUB_APP_PERMISSIONS, SKILL_FETCH_GITHUB_PERMISSIONS, UPDATE_DISPATCH_GITHUB_PERMISSIONS } from "./permissions.ts";

describe("containerGitHubPermissions", () => {
  it("writes code and pull requests, never workflows unless opted in", () => {
    expect(containerGitHubPermissions(false)).toEqual({ contents: "write", pull_requests: "write", metadata: "read" });
  });

  it("adds workflows for an opted-in Workspace", () => {
    expect(containerGitHubPermissions(true)).toEqual({ contents: "write", pull_requests: "write", metadata: "read", workflows: "write" });
  });
});

describe("the update dispatch token (ADR-0037)", () => {
  it("dispatches and reads workflow runs, and nothing else", () => {
    expect(UPDATE_DISPATCH_GITHUB_PERMISSIONS).toEqual({ actions: "write", metadata: "read" });
    expect(GITHUB_APP_PERMISSIONS.actions).toBe("write");
  });

  it("is the only list that writes Actions", () => {
    for (const list of [containerGitHubPermissions(false), containerGitHubPermissions(true), ENVIRONMENT_GITHUB_PERMISSIONS, SKILL_FETCH_GITHUB_PERMISSIONS]) {
      expect((list as Record<string, string>).actions).not.toBe("write");
    }
  });
});
