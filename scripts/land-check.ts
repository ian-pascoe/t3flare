// `node scripts/land-check.ts --kind t3|cli --branch <branch> [--tag <tag>]`: may this proposed pin land (ADR-0037;
// in-app updates plan D4)? Run by the land workflow on a fresh checkout before it fast-forwards `main`; exits 0 to land,
// 1 with the reason otherwise. The rules are `apps/environment/scripts/lib/land.ts`'s.
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { type LandKind, landRefusal } from "../apps/environment/scripts/lib/land.ts";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const kind = option("kind");
const branch = option("branch");
const tag = option("tag");
if ((kind !== "t3" && kind !== "cli") || branch === undefined || (kind === "t3" && tag === undefined)) {
  console.error("usage: node scripts/land-check.ts --kind t3|cli --branch <branch> [--tag <t3 tag>]");
  process.exit(2);
}

const git = (...gitArgs: Array<string>) => {
  const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
};

const ref = `origin/${branch}`;
const gitlink = kind === "t3" ? /^160000 commit ([0-9a-f]{40})\tt3code$/m.exec(git("ls-tree", ref, "t3code").out)?.[1] : undefined;
// The tag's commit, from t3code's own origin (.gitmodules), peeled when it is an annotated tag.
const tagCommit = (() => {
  if (kind !== "t3") return undefined;
  const url = git("config", "-f", ".gitmodules", "submodule.t3code.url").out;
  const lines = (spawnSync("git", ["ls-remote", url, `refs/tags/${tag!}`, `refs/tags/${tag!}^{}`], { encoding: "utf8" }).stdout ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t") as [string, string]);
  return (lines.find(([, name]) => name.endsWith("^{}")) ?? lines[0])?.[0];
})();
const facts = {
  kind: kind as LandKind,
  mainIsAncestor: git("merge-base", "--is-ancestor", "origin/main", ref).ok,
  commits: Number(git("rev-list", "--count", `origin/main..${ref}`).out || "0"),
  files: git("diff", "--name-only", "origin/main", ref).out.split("\n").filter((file) => file !== ""),
  ...(gitlink === undefined ? {} : { gitlink }),
  ...(tagCommit === undefined || tagCommit === "" ? {} : { tagCommit }),
};
console.log(JSON.stringify(facts));
const refusal = landRefusal(facts);
if (refusal !== undefined) {
  console.error(`land: refused: ${refusal}`);
  process.exit(1);
}
console.log(`land: ${ref} may land`);
