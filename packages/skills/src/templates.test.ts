// Prompt templates (SPI-1147 §1 and §4): pi's substitution and quoting, the frontmatter, and discovery at the cwd.
import { describe, expect, it } from "vitest";

import { discoverPrompts, expandTemplate, parseCommandArgs, parseTemplate, substituteArgs } from "./templates.ts";
import { memoryFiles } from "./testing.ts";

describe("pi's argument substitution", () => {
  it("fills $1, $2 … and leaves a missing one empty", () => {
    expect(substituteArgs("ECHO $1 and $2 [$3]", ["a", "b"])).toBe("ECHO a and b []");
  });

  it("fills $@ and $ARGUMENTS with every argument", () => {
    expect(substituteArgs("all: $@ / $ARGUMENTS", ["a", "b c"])).toBe("all: a b c / a b c");
  });

  it("uses ${N:-default} for a missing or empty argument", () => {
    expect(substituteArgs("ECHO $1 ${2:-none}", ["a"])).toBe("ECHO a none");
    expect(substituteArgs("ECHO $1 ${2:-none}", ["a", ""])).toBe("ECHO a none");
    expect(substituteArgs("ECHO $1 ${2:-none}", ["a", "b"])).toBe("ECHO a b");
    expect(substituteArgs("${@:-nothing}", [])).toBe("nothing");
  });

  it("slices with ${@:N} and ${@:N:L}", () => {
    expect(substituteArgs("${@:2}", ["a", "b", "c", "d"])).toBe("b c d");
    expect(substituteArgs("${@:2:2}", ["a", "b", "c", "d"])).toBe("b c");
  });

  it("does not substitute inside an argument", () => {
    expect(substituteArgs("$1 $2", ["$2", "x"])).toBe("$2 x");
  });

  it("leaves a default without its } and what follows it as written, and does not substitute inside a default", () => {
    expect(substituteArgs("${1:-x $2", ["", "b"])).toBe("${1:-x b");
    expect(substituteArgs("${1:-$2} $2", [])).toBe("$2 ");
    expect(substituteArgs("${1:-a}${2:-b}}", [])).toBe("ab}");
    expect(substituteArgs("$$1 ${x} $ ${@:-} ${@:0}", ["a"])).toBe("$a ${x} $ a a");
  });

  it("matches the single regex it replaces on every mix of its pieces", () => {
    const reference = (content: string, args: ReadonlyArray<string>) => {
      const all = args.join(" ");
      return content.replace(
        /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
        (_match, target: string | undefined, fallback: string | undefined, sliceStart: string | undefined, sliceLength: string | undefined, simple: string | undefined) => {
          if (target !== undefined) {
            const value = target === "@" || target === "ARGUMENTS" ? all : args[Number.parseInt(target, 10) - 1];
            return value === undefined || value === "" ? (fallback ?? "") : value;
          }
          if (sliceStart !== undefined) {
            const start = Math.max(Number.parseInt(sliceStart, 10) - 1, 0);
            return (sliceLength === undefined ? args.slice(start) : args.slice(start, start + Number.parseInt(sliceLength, 10))).join(" ");
          }
          if (simple === "ARGUMENTS" || simple === "@") return all;
          return args[Number.parseInt(simple ?? "0", 10) - 1] ?? "";
        },
      );
    };
    const pieces = ["$", "{", "}", ":", "-", "@", "1", "2", "0", "ARGUMENTS", "x", " "];
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (let run = 0; run < 5000; run++) {
      const content = Array.from({ length: next() % 24 }, () => pieces[next() % pieces.length]).join("");
      const args = [["a", "", "c d"], [], ["", ""]][run % 3]!;
      expect(substituteArgs(content, args), content).toBe(reference(content, args));
    }
  });

  it("fills a template of unclosed defaults in linear time", () => {
    const started = performance.now();
    const content = "${@:-".repeat(40_000);
    expect(substituteArgs(content, ["a"])).toBe(content);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("argument quoting", () => {
  it("splits on whitespace, groups quotes, and keeps a quoted empty string", () => {
    expect(parseCommandArgs(`a "b c" 'd e' "" f`)).toEqual(["a", "b c", "d e", "", "f"]);
    expect(parseCommandArgs("  ")).toEqual([]);
  });

  it("expands a leading /template with quoted arguments", () => {
    expect(expandTemplate(`/echo "two words" x`, [{ name: "echo", content: "ECHO $1 ${2:-none}" }])).toBe("ECHO two words x");
    expect(expandTemplate("/other a", [{ name: "echo", content: "x" }])).toBeUndefined();
    expect(expandTemplate("say /echo a", [{ name: "echo", content: "x" }])).toBeUndefined();
  });
});

describe("a template's file", () => {
  it("reads description and argument-hint from the frontmatter, and the body without it", () => {
    expect(parseTemplate("/r/.pi/prompts/review.md", "---\ndescription: Review a file\nargument-hint: <file> [focus]\n---\nReview $1.\n")).toEqual({
      name: "review",
      description: "Review a file",
      argumentHint: "<file> [focus]",
      filePath: "/r/.pi/prompts/review.md",
      content: "Review $1.",
    });
  });

  it("falls back to the body's first line, cut to 60 characters, for a description", () => {
    expect(parseTemplate("/r/a.md", "\nReply with exactly: ECHO $1\n")?.description).toBe("Reply with exactly: ECHO $1");
    expect(parseTemplate("/r/a.md", `${"y".repeat(70)}\n`)?.description).toBe(`${"y".repeat(60)}...`);
  });

  it("is not a template when its frontmatter is not YAML", () => {
    expect(parseTemplate("/r/a.md", "---\n: [\n---\nbody")).toBeUndefined();
  });
});

describe("Prompt templates' discovery", () => {
  const ROOT = "/workspace/repo";

  it("lists the .md files directly in the cwd's .pi/prompts, in name order", async () => {
    const files = memoryFiles({
      [`${ROOT}/.pi/prompts/echo.md`]: "Reply with exactly: ECHO $1 ${2:-none}",
      [`${ROOT}/.pi/prompts/a-review.md`]: "---\ndescription: Review\n---\nReview $@",
      [`${ROOT}/.pi/prompts/nested/deep.md`]: "nested",
      [`${ROOT}/.pi/prompts/notes.txt`]: "not markdown",
      [`${ROOT}/.pi/prompts/two words.md`]: "a space",
      [`${ROOT}/.agents/prompts/cloudpid.md`]: "cloudpid's convention",
      [`${ROOT}/.claude/commands/claude.md`]: "Claude's",
    });
    expect(await discoverPrompts(files, ROOT)).toEqual([
      { name: "a-review", description: "Review", filePath: `${ROOT}/.pi/prompts/a-review.md` },
      { name: "echo", description: "Reply with exactly: ECHO $1 ${2:-none}", filePath: `${ROOT}/.pi/prompts/echo.md` },
    ]);
  });

  it("looks at the cwd only, not the directories above it", async () => {
    const files = memoryFiles({ [`${ROOT}/.pi/prompts/echo.md`]: "x" });
    expect(await discoverPrompts(files, `${ROOT}/sub`)).toEqual([]);
  });

  it("keeps a dot-named file in .pi/prompts, as SPI-1147 did (the Durable agent's path is unchanged)", async () => {
    const files = memoryFiles({ [`${ROOT}/.pi/prompts/.hidden.md`]: "h", [`${ROOT}/.pi/prompts/echo.md`]: "e" });
    expect((await discoverPrompts(files, ROOT)).map((template) => template.name)).toEqual([".hidden", "echo"]);
  });

  it("with a CLI's sources (SPI-1151): a nested one names `sub/x.md` `sub:x` and skips dot directories, the first name wins", async () => {
    const files = memoryFiles({
      [`${ROOT}/.claude/commands/top.md`]: "t",
      [`${ROOT}/.claude/commands/sub/x.md`]: "x",
      [`${ROOT}/.claude/commands/.git/y.md`]: "y",
      [`${ROOT}/.opencode/command/a.md`]: "first",
      [`${ROOT}/.opencode/commands/a.md`]: "second",
      [`${ROOT}/.opencode/commands/sub/b.md`]: "not nested",
    });
    expect((await discoverPrompts(files, ROOT, [{ directory: ".claude/commands", nested: true }])).map((template) => template.name)).toEqual(["sub:x", "top"]);
    const opencode = await discoverPrompts(files, ROOT, [
      { directory: ".opencode/command", nested: false },
      { directory: ".opencode/commands", nested: false },
    ]);
    expect(opencode.map((template) => [template.name, template.filePath])).toEqual([["a", `${ROOT}/.opencode/command/a.md`]]);
  });
});
