// A Workspace's files in memory, for the tests of discovery: absolute paths to their text.
import type { ListedEntry, SkillFiles } from "./discovery.ts";

/** `files` as discovery reads them: a listing walks every file below a directory, with the directories between. */
export const memoryFiles = (files: Readonly<Record<string, string>>): SkillFiles & { readonly reads: Array<string> } => {
  const reads: Array<string> = [];
  return {
    reads,
    list: (directory, maxEntries) => {
      const prefix = `${directory}/`;
      const entries = new Map<string, ListedEntry>();
      for (const path of Object.keys(files).filter((path) => path.startsWith(prefix)).sort()) {
        const parts = path.slice(prefix.length).split("/");
        for (let depth = 1; depth < parts.length; depth++) {
          const dir = parts.slice(0, depth).join("/");
          if (!entries.has(dir)) entries.set(dir, { path: dir, kind: "directory" });
        }
        entries.set(parts.join("/"), { path: parts.join("/"), kind: "file" });
      }
      return Promise.resolve([...entries.values()].slice(0, maxEntries));
    },
    read: (path) => {
      reads.push(path);
      return Promise.resolve(files[path]);
    },
  };
};

/** A `SKILL.md` with `fields` as its frontmatter. */
export const skillMd = (fields: Readonly<Record<string, string | boolean>>, body = "Do the thing."): string =>
  `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? JSON.stringify(value) : String(value)}`)
    .join("\n")}\n---\n\n${body}\n`;
