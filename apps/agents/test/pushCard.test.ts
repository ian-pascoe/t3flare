// The push approval card (SPI-992, review M6): what the owner is shown about a push before it reaches GitHub. The tips
// are GitHub's; the commit subject and ancestry are the Workspace's own claims and are labelled so.
import { describe, expect, it } from "vitest";

import { advertisedTips, pushCard } from "../src/workspace/pushCard.ts";

const ZERO = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("pushCard", () => {
  const base = { linkLabel: "Laptop (Ian's MacBook)", defaultBranch: "main", reported: {} };

  it("shows each update against GitHub's tip, not the old id the Workspace sent", () => {
    const card = pushCard({ ...base, updates: [{ old: A, new: B, ref: "refs/heads/feature" }], tips: { "refs/heads/feature": C }, reported: { [B]: { subject: "Fix it", ancestor: { "refs/heads/feature": true } } } });
    expect(card.summary).toBe("push refs/heads/feature cccccccc → bbbbbbbb");
    expect(card.detail).toContain("GitHub has cccccccc (the Workspace said aaaaaaaa)");
    expect(card.detail).toContain('as reported by the Workspace: "Fix it", a fast-forward');
  });

  it("marks create, delete, force, the default branch and tags", () => {
    const card = pushCard({
      ...base,
      updates: [
        { old: ZERO, new: B, ref: "refs/heads/new" },
        { old: A, new: ZERO, ref: "refs/heads/old" },
        { old: A, new: B, ref: "refs/heads/main" },
        { old: ZERO, new: B, ref: "refs/tags/v1" },
      ],
      tips: { "refs/heads/old": A, "refs/heads/main": A },
      reported: { [B]: { subject: "s", ancestor: { "refs/heads/main": false } } },
    });
    expect(card.summary.split("\n")).toEqual([
      "create refs/heads/new → bbbbbbbb",
      "delete refs/heads/old (aaaaaaaa)",
      "force-push refs/heads/main (default branch) aaaaaaaa → bbbbbbbb",
      "create tag refs/tags/v1 → bbbbbbbb",
    ]);
  });

  it("calls a push whose ancestry the Workspace did not report possibly a force-push", () => {
    const card = pushCard({ ...base, updates: [{ old: A, new: B, ref: "refs/heads/x" }], tips: { "refs/heads/x": A } });
    expect(card.summary).toBe("push refs/heads/x aaaaaaaa → bbbbbbbb (may not be a fast-forward)");
  });

  it("escapes anything but printable ASCII in ref names and subjects", () => {
    const card = pushCard({ ...base, updates: [{ old: ZERO, new: B, ref: "refs/heads/fe\u0430ture\u202e" }], tips: {}, reported: { [B]: { subject: "a\u001b[2Jb", ancestor: {} } } });
    expect(card.summary).toBe("create refs/heads/fe\\u{430}ture\\u{202e} → bbbbbbbb");
    expect(card.detail).toContain('"a\\u{1b}[2Jb"');
  });
});

describe("advertisedTips", () => {
  it("reads the refs GitHub advertises for receive-pack", () => {
    const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
    const body = `${pkt("# service=git-receive-pack\n")}0000${pkt(`${A} refs/heads/main\0report-status delete-refs\n`)}${pkt(`${B} refs/tags/v1\n`)}0000`;
    expect(advertisedTips(new TextEncoder().encode(body))).toEqual({ "refs/heads/main": A, "refs/tags/v1": B });
  });

  it("reads an empty repository's advertisement as no refs", () => {
    const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
    const body = `${pkt("# service=git-receive-pack\n")}0000${pkt(`${ZERO} capabilities^{}\0report-status\n`)}0000`;
    expect(advertisedTips(new TextEncoder().encode(body))).toEqual({});
  });
});
