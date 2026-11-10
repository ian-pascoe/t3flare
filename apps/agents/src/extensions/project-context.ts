// The `project_context` section (step 2a plan, section 4; cloudpid's `agents-md`, trimmed to its section): the
// repository's `AGENTS.md` (or `CLAUDE.md`) files, from the repo root down to the conversation's working directory,
// read through the call's environment before each request. cloudpid also wraps `read`/`edit`/`write` to show nested
// files' instructions as the agent reaches them; part 1 keeps only the section.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

const NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
/** The most of one file the section shows. */
const MAX_FILE_CHARS = 16_000;

/** The directories from `root` down to `cwd` (just `root` when `cwd` is outside it). */
const chain = (root: string, cwd: string): ReadonlyArray<string> => {
  if (cwd !== root && !cwd.startsWith(`${root}/`)) return [root];
  const below = cwd.slice(root.length).split("/").filter(Boolean);
  return [root, ...below.map((_, at) => `${root}/${below.slice(0, at + 1).join("/")}`)];
};

/** The section, for a repo at `root`. */
export const projectContext = (root: string): Extension =>
  defineExtension({
    name: "project-context",
    sections: [
      section("project_context", async (input, context) => {
        const env = input.env;
        if (env === undefined) return undefined;
        const parts: Array<string> = [
          `You work in a git repository at ${root}, the owner's project. Its files are yours to read and change; the owner reviews your changes as a diff.`,
        ];
        for (const directory of chain(root, env.cwd)) {
          for (const name of NAMES) {
            const read = await env.readTextFile(`${directory}/${name}`, context).catch(() => undefined);
            if (read === undefined || !read.ok) continue;
            const body = read.value.length > MAX_FILE_CHARS ? `${read.value.slice(0, MAX_FILE_CHARS)}\n… [cut]` : read.value;
            parts.push(`## ${directory}/${name}\n\n${body.trim()}`);
            break;
          }
        }
        return parts.join("\n\n");
      }),
    ],
  });
