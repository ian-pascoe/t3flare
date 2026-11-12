// The push gateway (SPI-992, review M1): what it reads from a Container's receive-pack request, checked against the
// request prefixes git 2.56 sent in probe P4 (`scripts/p4-push-shapes.ts`) and against a strict pkt-line grammar.
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { type GatewayDeps, handleGitRequest, parseCommands, type RefUpdate, serialiseCommands } from "../src/workspace/pushGateway.ts";
import { gitAsync, gitEnv, gitSync, makeUpstream, serve, tempDir } from "./gitHttp.fixture.ts";

const fixture = (name: string): Uint8Array => new Uint8Array(Buffer.from(fs.readFileSync(path.join(import.meta.dirname, "fixtures/receive-pack", `${name}.prefix.b64`), "utf8"), "base64"));
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const pkt = (line: string): string => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
const ZERO = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);

describe("parseCommands: the receive-pack command list git 2.56 sends (P4 fixtures)", () => {
  it("reads t3's `push -- origin HEAD:refs/heads/<b>` as one creation", () => {
    const parsed = parseCommands(fixture("t3-form"));
    expect(parsed.kind).toBe("commands");
    if (parsed.kind !== "commands") return;
    expect(parsed.updates).toHaveLength(1);
    expect(parsed.updates[0]).toMatchObject({ old: ZERO, ref: "refs/heads/spi992/t3" });
    expect(parsed.capabilities).toEqual(expect.arrayContaining(["report-status-v2", "side-band-64k", "quiet", "object-format=sha1"]));
  });

  it("reads a delete, an atomic two-ref push, a tag and push options", () => {
    const deleted = parseCommands(fixture("delete"));
    expect(deleted.kind === "commands" && deleted.updates[0]?.new).toBe(ZERO);
    const atomic = parseCommands(fixture("atomic-two"));
    expect(atomic.kind === "commands" && atomic.updates.map((u) => u.ref)).toEqual(["refs/heads/main", "refs/heads/spi992/two"]);
    const tag = parseCommands(fixture("tag"));
    expect(tag.kind === "commands" && tag.updates[0]?.ref).toBe("refs/tags/v1");
    const options = parseCommands(fixture("push-option-advertised"));
    expect(options.kind === "commands" && options.pushOptions).toEqual(["ci.skip"]);
  });

  it("knows git's probe (`0000` before a chunked push)", () => {
    expect(parseCommands(fixture("large-0")).kind).toBe("probe");
    expect(parseCommands(fixture("large-1")).kind).toBe("commands");
  });

  it("asks for more bytes while the command list is not complete", () => {
    const whole = fixture("first");
    expect(parseCommands(whole.subarray(0, 30)).kind).toBe("incomplete");
    expect(parseCommands(whole.subarray(0, whole.length - 2)).kind).toBe("incomplete");
  });
});

describe("serialiseCommands", () => {
  it("rebuilds git's own bytes from what was parsed (every P4 fixture with updates)", () => {
    for (const name of ["first", "t3-form", "delete", "atomic-two", "push-option-advertised", "force", "tag", "large-1"]) {
      const bytes = fixture(name);
      const parsed = parseCommands(bytes);
      if (parsed.kind !== "commands") throw new Error(name);
      expect(Buffer.from(serialiseCommands(parsed)).toString("latin1"), name).toBe(Buffer.from(bytes.subarray(0, parsed.consumed)).toString("latin1"));
    }
  });
});

describe("parseCommands: the strict grammar (review M1)", () => {
  const refuse = (body: string) => {
    const parsed = parseCommands(text(body));
    expect(parsed.kind).toBe("refuse");
    return parsed.kind === "refuse" ? parsed.reason : "";
  };

  it("refuses non-hex or upper-case lengths", () => {
    refuse(`00ZZ${A} ${B} refs/heads/x\0report-status0000`);
    refuse(`${pkt(`${A} ${B} refs/heads/x\0report-status`).replace(/^00/, "00").toUpperCase()}0000`);
  });

  it("refuses oids that are not 40 or 64 lower-case hex, or differ in length", () => {
    refuse(`${pkt(`${"A".repeat(40)} ${B} refs/heads/x\0report-status`)}0000`);
    refuse(`${pkt(`${A.slice(1)} ${B} refs/heads/x\0report-status`)}0000`);
    refuse(`${pkt(`${A} ${"b".repeat(64)} refs/heads/x\0report-status`)}0000`);
  });

  it("refuses ref names git's check-ref-format refuses", () => {
    for (const ref of ["refs/heads/a..b", "refs/heads/x.lock", "refs/heads/a b", "refs/heads/@{x}", "HEAD", "refs/heads/", "refs/heads/a\\b", "refs/heads//a", "refs/heads/.a", "refs/heads/a.", "refs/heads/a~1", "refs/heads/a^", "refs/heads/a:b", "refs/heads/a?", "refs/heads/a*", "refs/heads/a[", "refs/heads/a\u007f"]) {
      refuse(`${pkt(`${A} ${B} ${ref}\0report-status`)}0000`);
    }
  });

  it("refuses unknown capabilities, push certificates and too many updates", () => {
    expect(refuse(`${pkt(`${A} ${B} refs/heads/x\0report-status no-thin`)}0000`)).toMatch(/no-thin/);
    expect(refuse(`${pkt("push-cert\0report-status")}0000`)).toMatch(/push certificate/i);
    const many = Array.from({ length: 65 }, (_, i) => pkt(`${A} ${B} refs/heads/x${i}${i === 0 ? "\0report-status" : ""}`)).join("");
    expect(refuse(`${many}0000`)).toMatch(/64/);
  });

  it("refuses a command prefix over the byte cap", () => {
    const long = Array.from({ length: 60 }, (_, i) => pkt(`${A} ${B} refs/heads/${"x".repeat(1200)}${i}${i === 0 ? "\0report-status" : ""}`)).join("");
    expect(refuse(long)).toMatch(/too large/);
  });
});

describe("handleGitRequest: real git through the gateway to a local GitHub stand-in", () => {
  const setup = async (authorize: GatewayDeps["authorize"]) => {
    const root = tempDir("gateway-");
    const upstream = makeUpstream(path.join(root, "github"), "Owner", "repo");
    const calls: Array<{ readonly updates: ReadonlyArray<RefUpdate> }> = [];
    const deps: GatewayDeps = {
      repo: { owner: "owner", name: "Repo" },
      token: () => Promise.resolve("ghs_gatewaytoken"),
      authorize: (push) => {
        calls.push(push);
        return authorize(push);
      },
      fetch: upstream.fetch,
    };
    const server = await serve((request) => handleGitRequest(request, deps));
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const env = gitEnv(root);
    gitSync(work, env, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(work, "a"), "a");
    gitSync(work, env, "add", "a");
    gitSync(work, env, "commit", "-qm", "a");
    const remote = `http://127.0.0.1:${server.port}/t3flare/git/OWNER/repo.git`;
    return { upstream, calls, server, work, env, remote, head: gitSync(work, env, "rev-parse", "HEAD") };
  };

  it("lands an approved push with the gateway's token, never the client's headers, and no redirects", async () => {
    const t = await setup(() => Promise.resolve({ allow: true }));
    const pushed = await gitAsync(t.work, t.env, "-c", "http.extraHeader=Authorization: Basic Y2xpZW50OnNlY3JldA==", "-c", "http.extraHeader=Cookie: c=1", "push", "--", t.remote, "HEAD:refs/heads/spi992/a");
    await t.server.close();
    expect(pushed.code, pushed.output).toBe(0);
    expect(t.upstream.refs()).toContain(`refs/heads/spi992/a ${t.head}`);
    expect(t.calls).toEqual([{ updates: [{ old: ZERO, new: t.head, ref: "refs/heads/spi992/a" }], pushOptions: [] }]);
    for (const seen of t.upstream.seen) {
      expect(seen.url.startsWith("https://github.com/owner/Repo.git/")).toBe(true);
      expect(seen.headers.authorization).toBe(`Basic ${Buffer.from("x-access-token:ghs_gatewaytoken").toString("base64")}`);
      expect(seen.headers.cookie).toBeUndefined();
      expect(seen.redirect).toBe("manual");
    }
  });

  it("answers a declined push with git's own `remote rejected`, and GitHub never sees it", async () => {
    const t = await setup(() => Promise.resolve({ allow: false, reason: "declined by the owner" }));
    const pushed = await gitAsync(t.work, t.env, "push", t.remote, "HEAD:refs/heads/spi992/b");
    await t.server.close();
    expect(pushed.code).not.toBe(0);
    expect(pushed.output).toMatch(/\[remote rejected\] +HEAD -> spi992\/b \(declined by the owner\)/);
    expect(t.upstream.refs()).toBe("");
    expect(t.upstream.seen.filter((seen) => seen.method === "POST")).toHaveLength(0);
  });

  it("asks once for a push larger than http.postBuffer (probe, then chunked)", async () => {
    const t = await setup(() => Promise.resolve({ allow: true }));
    fs.writeFileSync(path.join(t.work, "big"), Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7919) % 251)));
    gitSync(t.work, t.env, "add", "big");
    gitSync(t.work, t.env, "commit", "-qm", "big");
    const pushed = await gitAsync(t.work, t.env, "-c", "http.postBuffer=65536", "push", t.remote, "HEAD:refs/heads/main");
    await t.server.close();
    expect(pushed.code, pushed.output).toBe(0);
    expect(t.calls).toHaveLength(1);
    expect(t.upstream.refs()).toContain("refs/heads/main");
  });

  it("refuses another repo, other paths and query strings, and a compressed receive-pack body", async () => {
    const t = await setup(() => Promise.resolve({ allow: true }));
    const base = `http://127.0.0.1:${t.server.port}/t3flare/git`;
    const status = async (url: string, init?: RequestInit) => (await globalThis.fetch(url, init)).status;
    expect(await status(`${base}/owner/other.git/info/refs?service=git-receive-pack`)).toBe(404);
    expect(await status(`${base}/owner/repo.git/info/refs?service=git-upload-pack`)).toBe(404);
    expect(await status(`${base}/owner/repo.git/info/refs?service=git-receive-pack&x=1`)).toBe(404);
    expect(await status(`${base}/owner/repo.git/git-upload-pack`, { method: "POST", body: "0000" })).toBe(404);
    expect(await status(`${base}/owner/repo.git/../other/info/refs?service=git-receive-pack`)).toBe(404);
    expect(await status(`${base}/owner/repo.git/git-receive-pack`, { method: "POST", body: "0000", headers: { "content-type": "application/x-git-receive-pack-request", "content-encoding": "gzip" } })).toBe(415);
    await t.server.close();
    expect(t.calls).toHaveLength(0);
    expect(t.upstream.seen).toHaveLength(0);
  });
});
