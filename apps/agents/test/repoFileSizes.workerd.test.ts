// SPI-1050: the in-DO git guard reads the repo's file sizes from computer's VFS tables (`vfs_dirents`, `vfs_nodes`)
// directly. Run against a real computer Workspace in a real Durable Object's SQLite, so a schema change in computer
// fails here (upstream-fragility U23).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { VfsProbe } from "./workerd.fixture.ts";

const bindings = env as unknown as { VFS_PROBE: DurableObjectNamespace<VfsProbe> };
const probe = () => bindings.VFS_PROBE.get(bindings.VFS_PROBE.newUniqueId());

describe("repoFileSizes", () => {
  it("finds the largest file at any depth, .git included, and sums the working tree outside .git", async () => {
    const p = probe();
    expect(await p.sizes("/workspace/repo")).toEqual({ largest: 0, worktreeBytes: 0 });
    await p.write("/workspace/repo/a.txt", 10);
    await p.write("/workspace/repo/src/deep/b.bin", 700_000);
    await p.write("/workspace/repo/.git/objects/ab/cdef", 1_200_000);
    await p.write("/workspace/repo/.github/x.yml", 5);
    await p.write("/workspace/outside.bin", 5_000_000);
    expect(await p.sizes("/workspace/repo")).toEqual({ largest: 1_200_000, worktreeBytes: 700_015 });
    await p.remove("/workspace/repo/.git/objects/ab/cdef");
    expect(await p.sizes("/workspace/repo")).toEqual({ largest: 700_000, worktreeBytes: 700_015 });
    expect(await p.sizes("/workspace/missing")).toEqual({ largest: 0, worktreeBytes: 0 });
  });

  it("does not follow a symlink, and counts a directory as nothing", async () => {
    const p = probe();
    await p.write("/workspace/outside/huge.bin", 3_000_000);
    await p.symlink("/workspace/outside", "/workspace/repo/linked-dir");
    await p.symlink("/workspace/outside/huge.bin", "/workspace/repo/linked-file");
    await p.write("/workspace/repo/small.txt", 3);
    expect(await p.sizes("/workspace/repo")).toEqual({ largest: 3, worktreeBytes: 3 });
  });
});
