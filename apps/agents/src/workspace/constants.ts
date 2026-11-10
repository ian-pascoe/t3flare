// Names the Workspace DO and its callers share (step 2a plan, section 2, Paths).

/** The binding the Workspace DO namespace has in every Worker that hosts or calls it; computer's proxies find it by name. */
export const WORKSPACE_BINDING = "WORKSPACES";

/** The Container the Workspace DO runs: its id in the stack and its key in `ctx.container.images`. */
export const WORKSPACE_CONTAINER = "WorkspaceContainer";

/** computer's fixed working root, on the DO's side and in the Container (`@cloudflare/computer` WORKSPACE_ROOT). */
export const WORKSPACE_ROOT = "/workspace";

/** Where a Workspace's one repo is, inside the Workspace. t3 sees it as `/w/<id>`. */
export const REPO_ROOT = "/workspace/repo";

/** The harness's own files (temp files, spills), beside the repo, never in it. */
export const HARNESS_ROOT = "/workspace/.t3flare";

/** computer's default id of the Container backend. */
export const CONTAINER_BACKEND = "container-shell";

/** computer's default id of the Worker Shell backend. */
export const WORKER_SHELL_BACKEND = "worker-shell";

/**
 * The Container size (cloudpid's `cpu-1`): 1 vCPU, 3 GiB, 12 GB of disk. Memory is most of what a running Container
 * costs; this is the smallest custom size with the most vCPU for its memory.
 */
export const CONTAINER_INSTANCE = { vcpu: 1, memoryMib: 3072, diskMb: 12000 } as const;

/** A Container stops after this long without a command. */
export const CONTAINER_IDLE_MS = 2 * 60_000;

/**
 * Dependency directories, build output and caches stay on the Container's disk, out of the Workspace DO (cloudpid's
 * TOOLCHAIN_IGNORE, trimmed): syncing them would fill the DO's SQLite and slow every command.
 */
export const CONTAINER_IGNORE: ReadonlyArray<string> = [
  "**/node_modules",
  "**/.venv",
  "/target",
  "/*/target",
  "**/.cache",
  "**/.pnpm-store",
  "**/__pycache__",
  "**/.pytest_cache",
  "**/.mypy_cache",
  "**/.ruff_cache",
  "**/.turbo",
  "**/.next",
  "**/.nuxt",
  "**/.svelte-kit",
  "**/.parcel-cache",
  "**/.terraform",
  "**/.gradle",
  "**/.wrangler",
  // The harness's own directory is always synced, so both sides see it.
  "!/.t3flare",
  "!/.t3flare/**",
];

/** t3's path for Workspace `id`'s repo root. */
export const t3PathOf = (id: string) => `/w/${id}`;

/** A Workspace id: the one path segment under `/w` (ADR-0008). */
export const WORKSPACE_ID = /^[A-Za-z0-9._-]{1,100}$/;
