// isomorphic-git's file system over the Workspace's own files (computer's SQLite VFS), as
// `@cloudflare/computer@0.9.0`'s `git` entry builds it (`workspaceIsomorphicGitClient`, which it does not export):
// `@platformatic/vfs` over a `VirtualProvider` that forwards to computer's `SQLiteWorkspaceProvider`. Reads and writes
// go straight to the Workspace DO's SQLite, so they move its revision as any other write does.
import type { Workspace as ComputerWorkspace } from "@cloudflare/computer";
import { create, VirtualProvider } from "@platformatic/vfs";

import type { GitFs } from "./gitRepo.ts";

const FORWARDED = [
  "open",
  "openSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "readdir",
  "readdirSync",
  "mkdir",
  "mkdirSync",
  "rmdir",
  "rmdirSync",
  "unlink",
  "unlinkSync",
  "rename",
  "renameSync",
  "readFile",
  "readFileSync",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "exists",
  "existsSync",
  "copyFile",
  "copyFileSync",
  "internalModuleStat",
  "realpath",
  "realpathSync",
  "access",
  "accessSync",
  "readlink",
  "readlinkSync",
  "symlink",
  "symlinkSync",
  "closeSync",
  "readSync",
  "writeSync",
  "fstatSync",
  "truncateSync",
  "ftruncateSync",
] as const;

type Provider = ReturnType<ComputerWorkspace["provider"]>;

/** isomorphic-git's file system over `workspace`'s files. */
export const isomorphicFs = (workspace: ComputerWorkspace): GitFs => {
  const inner: Provider = workspace.provider();
  class Forwarding extends VirtualProvider {
    override get readonly(): boolean {
      return (inner as unknown as { readonly: boolean }).readonly;
    }
    override get supportsSymlinks(): boolean {
      return (inner as unknown as { supportsSymlinks: boolean }).supportsSymlinks;
    }
  }
  for (const name of FORWARDED) {
    Object.defineProperty(Forwarding.prototype, name, {
      value(...args: Array<unknown>) {
        const method = (inner as unknown as Record<string, unknown>)[name];
        if (typeof method !== "function") throw new Error(`SQLiteWorkspaceProvider.${name} is not a function`);
        return (method as (...rest: Array<unknown>) => unknown).apply(inner, args);
      },
      writable: true,
      configurable: true,
    });
  }
  return { promises: create(new Forwarding(), { moduleHooks: false }).promises } as unknown as GitFs;
};
