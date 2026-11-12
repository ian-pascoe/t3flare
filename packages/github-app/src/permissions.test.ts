// The Container token's permissions (ADR-0013; back to stock, owner 2026-11-12): the Workspace's one repo, code
// writable from the Container's own git, and `workflows` only for a Workspace the owner opted in (K7).
import { describe, expect, it } from "vitest";

import { containerGitHubPermissions } from "./permissions.ts";

describe("containerGitHubPermissions", () => {
  it("writes code and pull requests, never workflows unless opted in", () => {
    expect(containerGitHubPermissions(false)).toEqual({ contents: "write", pull_requests: "write", metadata: "read" });
  });

  it("adds workflows for an opted-in Workspace", () => {
    expect(containerGitHubPermissions(true)).toEqual({ contents: "write", pull_requests: "write", metadata: "read", workflows: "write" });
  });
});
