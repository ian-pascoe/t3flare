// SPI-1050: the in-DO git guard's largest-file check reads computer's VFS tables (`vfs_dirents`, `vfs_nodes`) directly.
// Run against a real computer Workspace in a real Durable Object's SQLite, so a schema change in computer fails here
// (upstream-fragility U23).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { VfsProbe } from "./workerd.fixture.ts";

const bindings = env as unknown as { VFS_PROBE: DurableObjectNamespace<VfsProbe> };
const probe = () => bindings.VFS_PROBE.get(bindings.VFS_PROBE.newUniqueId());

describe("largestFileUnder", () => {
  it("finds the largest file at any depth under the repo, .git included, and ignores files outside it", async () => {
    const p = probe();
    expect(await p.largest("/workspace/repo")).toBe(0);
    await p.write("/workspace/repo/a.txt", 10);
    await p.write("/workspace/repo/src/deep/b.bin", 700_000);
    await p.write("/workspace/repo/.git/objects/ab/cdef", 1_200_000);
    await p.write("/workspace/outside.bin", 5_000_000);
    expect(await p.largest("/workspace/repo")).toBe(1_200_000);
    await p.remove("/workspace/repo/.git/objects/ab/cdef");
    expect(await p.largest("/workspace/repo")).toBe(700_000);
    expect(await p.largest("/workspace/missing")).toBe(0);
  });
});
