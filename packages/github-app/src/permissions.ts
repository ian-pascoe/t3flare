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
 * A Workspace's Container token (git and gh there; the agent can read it, SPI-992): one repo, **read-only code**. It
 * fetches and clones, and keeps `pull_requests: write` (owner's decision, review M4) so an agent's `gh pr create`/`view`
 * work: a pull request carries no code, its branch must already be on GitHub. No token that can write code ever enters
 * a Container; pushes go through the push gateway (`PUSH_GATEWAY_PERMISSIONS`).
 */
export const CONTAINER_GITHUB_PERMISSIONS = {
  contents: "read",
  pull_requests: "write",
  metadata: "read",
} as const satisfies GitHubPermissions;

/**
 * The push gateway's token (SPI-992): `contents: write` on the Workspace's one repo, added by the agents Worker to a
 * push the gateway's policy allowed. Never reaches a Container or a Session.
 */
export const PUSH_GATEWAY_PERMISSIONS = {
  contents: "write",
  metadata: "read",
} as const satisfies GitHubPermissions;

/** The push gateway's token for a Workspace the owner opted in to changing CI. */
export const PUSH_GATEWAY_WORKFLOWS_PERMISSIONS = {
  ...PUSH_GATEWAY_PERMISSIONS,
  workflows: "write",
} as const satisfies GitHubPermissions;

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
