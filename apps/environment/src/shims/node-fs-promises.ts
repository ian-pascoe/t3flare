// @effect-diagnostics nodeBuiltinImport:off
// `node:fs/promises` for t3's own modules: the synchronous State-directory calls of
// ./node-fs.ts, resolved as promises. DO SQLite is synchronous, so nothing is lost.
import * as fs from "./node-fs.ts";
import * as store from "../platform/stateStore.ts";

export * from "node:fs/promises";

const lift =
  <A extends Array<any>, R>(f: (...args: A) => R) =>
  async (...args: A): Promise<R> =>
    f(...args);

export const readFile = lift(fs.readFileSync);
export const writeFile = lift(fs.writeFileSync);
export const appendFile = lift(fs.appendFileSync);
export const mkdir = lift(fs.mkdirSync);
export const mkdtemp = lift(fs.mkdtempSync);
export const readdir = lift(fs.readdirSync);
export const rm = lift(fs.rmSync);
export const rmdir = lift(fs.rmdirSync);
export const unlink = lift(fs.unlinkSync);
export const rename = lift(fs.renameSync);
export const copyFile = lift(fs.copyFileSync);
export const realpath = lift(fs.realpathSync);
export const symlink = lift(fs.symlinkSync);
export const readlink = lift(fs.readlinkSync);
export const chmod = lift(fs.chmodSync);
export const utimes = lift(fs.utimesSync);
export const truncate = lift(fs.truncateSync);
export const access = lift(fs.accessSync);
export const stat = lift((path: unknown) => fs.statSync(path));
export const lstat = lift((path: unknown) => fs.lstatSync(path));
export const statfs = async () => ({ type: 0, bsize: 4096, blocks: 2_621_440, bfree: 2_621_440, bavail: 2_621_440, files: 0, ffree: 0 });

class FileHandle {
  readonly fd: number;
  constructor(fd: number) {
    this.fd = fd;
  }
  async writeFile(data: unknown) { fs.writeSync(this.fd, data); }
  async write(data: unknown) { return { bytesWritten: fs.writeSync(this.fd, data) }; }
  async appendFile(data: unknown) { fs.writeSync(this.fd, data); }
  async stat() { return fs.fstatSync(this.fd); }
  async sync() {}
  async datasync() {}
  async close() { fs.closeSync(this.fd); }
  async [Symbol.asyncDispose]() { fs.closeSync(this.fd); }
}

export const open = async (path: unknown, flags?: string, mode?: number) => new FileHandle(fs.openSync(path, flags, mode));

export { FileHandle };
export const constants = fs.constants;

export default {
  readFile, writeFile, appendFile, mkdir, mkdtemp, readdir, rm, rmdir, unlink, rename, copyFile,
  realpath, symlink, readlink, chmod, utimes, truncate, access, stat, lstat, statfs, open, constants,
};

void store;
