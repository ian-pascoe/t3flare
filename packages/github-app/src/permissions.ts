// The GitHub permissions t3flare asks for (ADR-0013; adapted from cloudpid@ae5a7b73:packages/config/src/github-permissions.ts).
// Three lists, so a permission the App gains reaches a token only by being added to that token's list on purpose.

/** A permission's level on a repository. */
export type GitHubPermissionLevel = "read" | "write";

/** A set of GitHub permissions: each permission's name and its level. */
export type GitHubPermissions = Readonly<Record<string, GitHubPermissionLevel>>;

/** What the App asks for when it is registered: everything any of its tokens may be minted with. No webhooks. */
export const GITHUB_APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  workflows: "write",
  checks: "read",
  statuses: "read",
  actions: "read",
  issues: "read",
  metadata: "read",
} as const satisfies GitHubPermissions;

/**
 * A Workspace's Container token (git and gh there; the agent can read it): one repo, code and pull requests writable,
 * as before SPI-992 (owner, 2026-11-12, back to stock: no push gateway). No `workflows` unless the Workspace is opted
 * in (`CONTAINER_WORKFLOWS_PERMISSIONS`).
 */
export const CONTAINER_GITHUB_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
} as const satisfies GitHubPermissions;

/** A Container token for a Workspace the owner opted in to changing CI. */
export const CONTAINER_WORKFLOWS_PERMISSIONS = {
  ...CONTAINER_GITHUB_PERMISSIONS,
  workflows: "write",
} as const satisfies GitHubPermissions;

/** The Container token's permissions for a Workspace, by its `workflows` opt-in. */
export const containerGitHubPermissions = (workflows: boolean): GitHubPermissions => (workflows ? CONTAINER_WORKFLOWS_PERMISSIONS : CONTAINER_GITHUB_PERMISSIONS);

/** The Environment DO's own token for t3's PR features: never reaches a Container or a Session. */
export const ENVIRONMENT_GITHUB_PERMISSIONS = {
  contents: "read",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
  actions: "read",
  issues: "read",
  metadata: "read",
} as const satisfies GitHubPermissions;

/**
 * The Environment DO's token for reading Environment skills from GitHub (SPI-1148, ADR-0033): one repo's contents, read
 * only, used for the fetch's own requests and dropped. Scoped to an installed repo, it also reads public repos outside
 * the installation (docs/steps/spi-1001-env-plan.md §1, R1).
 */
export const SKILL_FETCH_GITHUB_PERMISSIONS = {
  contents: "read",
  metadata: "read",
} as const satisfies GitHubPermissions;
