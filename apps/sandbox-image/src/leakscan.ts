// The Container's credential scanner (step 4a, plan §4.7 with review F3). No Node imports, so the agents Worker can
// import it and run it with the image's Node in the Container.
//
// No credential is sent in to be looked for: each is described by its first few characters (a public format prefix,
// `cms_`, `ghs_`), its length and its SHA-256. The scanner finds every occurrence of a prefix in the files it reads and
// hashes the `length` characters starting there, so a credential is found wherever it sits, whatever surrounds it.
//
// Two uses:
// - before a pull, on the files changed since the last scan (`since`): a hit is moved out of the synced tree into
//   `quarantine` (on the Container's own disk) before computer can pull it, and named in the answer;
// - the leak check (`full`): every file under the roots, and each process's environment and command line.

export interface CredentialPattern {
  /** A short name for the answer (never the value). */
  readonly name: string;
  readonly prefix: string;
  readonly length: number;
  readonly sha256: string;
}

export interface LeakScanInput {
  readonly patterns: ReadonlyArray<CredentialPattern>;
  readonly roots: ReadonlyArray<string>;
  /** Skip files whose mtime is not after this (ms); 0 scans everything. */
  readonly since: number;
  /** Where a file with a hit is moved; none: report only. */
  readonly quarantine?: string;
  /** Also scan /proc/<pid>/environ and cmdline. */
  readonly procs?: boolean;
  /** Path segments never descended into. */
  readonly skip?: ReadonlyArray<string>;
}

export interface LeakScanAnswer {
  readonly hits: ReadonlyArray<{ readonly name: string; readonly path: string; readonly quarantined?: string }>;
  readonly files: number;
  readonly bytes: number;
  readonly ms: number;
}

/** The image's Node (the CLI layer's), by absolute path. */
export const IMAGE_NODE = "/usr/local/share/mise/installs/node/26.13.0/bin/node";

/** The scanner, run as `node -e <this> <input JSON>`; prints the answer as one JSON line. */
export const LEAKSCAN_JS = String.raw`
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const input = JSON.parse(process.argv[1] ?? process.argv[2]);
const started = Date.now();
const hits = []; let files = 0, bytes = 0;
const MAX = 64 * 1024 * 1024;
const skip = new Set(input.skip ?? []);
const scanBuffer = (buffer) => {
  const found = [];
  const text = buffer.toString("latin1");
  for (const p of input.patterns) {
    let at = text.indexOf(p.prefix);
    while (at !== -1) {
      const candidate = text.slice(at, at + p.length);
      if (candidate.length === p.length && crypto.createHash("sha256").update(candidate, "latin1").digest("hex") === p.sha256) { found.push(p.name); break; }
      at = text.indexOf(p.prefix, at + 1);
    }
  }
  return found;
};
const visit = (file) => {
  let stat; try { stat = fs.lstatSync(file); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    if (skip.has(path.basename(file))) return;
    let names = []; try { names = fs.readdirSync(file); } catch { return; }
    for (const name of names) visit(path.join(file, name));
    return;
  }
  if (!stat.isFile() || stat.size > MAX || stat.mtimeMs <= input.since) return;
  let buffer; try { buffer = fs.readFileSync(file); } catch { return; }
  files++; bytes += buffer.length;
  const names = scanBuffer(buffer);
  if (names.length === 0) return;
  let quarantined;
  if (input.quarantine) {
    try {
      fs.mkdirSync(input.quarantine, { recursive: true, mode: 0o700 });
      quarantined = path.join(input.quarantine, Date.now() + "-" + path.basename(file));
      fs.copyFileSync(file, quarantined); fs.rmSync(file, { force: true });
    } catch { quarantined = undefined; }
  }
  for (const name of new Set(names)) hits.push({ name, path: file, ...(quarantined ? { quarantined } : {}) });
};
for (const root of input.roots) visit(root);
if (input.procs) {
  for (const pid of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    for (const what of ["environ", "cmdline"]) {
      let buffer; try { buffer = fs.readFileSync("/proc/" + pid + "/" + what); } catch { continue; }
      for (const name of new Set(scanBuffer(buffer))) hits.push({ name, path: "/proc/" + pid + "/" + what });
    }
  }
}
process.stdout.write(JSON.stringify({ hits, files, bytes, ms: Date.now() - started }) + "\n");
`;

/** argv for the platform's exec: the image's Node running the scanner on `input`. */
export const leakScanArgv = (input: LeakScanInput): ReadonlyArray<string> => [IMAGE_NODE, "-e", LEAKSCAN_JS, JSON.stringify(input)];

/** A credential's pattern: its first four characters, its length and its SHA-256 (hex), from Web Crypto. */
export const patternOf = async (name: string, value: string): Promise<CredentialPattern> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { name, prefix: value.slice(0, 4), length: value.length, sha256 };
};
