// @effect-diagnostics globalConsole:off
// Deletes the projects and threads a check left on a stage: those whose title is the prefix and a base-36 stamp
// (`models k3j9x2`) and whose workspace root is under the given directory. A dry run unless `--delete` is given.
//
//   bun scripts/stage.ts run <stage> forget <title prefix> <workspace root prefix> [--delete]
import { dispatch, mutateProject, pair, uuid, wsFirst } from "./lib/client.ts";

const [prefix, rootPrefix] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (prefix === undefined || rootPrefix === undefined) throw new Error("usage: forget <title prefix> <workspace root prefix> [--delete]");
const really = process.argv.includes("--delete");

const cookie = await pair();
const shell = (await wsFirst(cookie, "orchestration.subscribeShell", {})) as any;
const snapshot = shell?.snapshot ?? shell;
const projects: Array<any> = snapshot?.projects ?? [];
const threads: Array<any> = snapshot?.threads ?? [];
const stamped = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} [0-9a-z]+$`);
const mine = projects.filter((project) => stamped.test(String(project.title)) && String(project.workspaceRoot).startsWith(rootPrefix));
console.log(JSON.stringify({ shellKeys: Object.keys(snapshot ?? {}), projects: projects.length, threads: threads.length, matching: mine.map((p) => ({ id: p.id ?? p.projectId, title: p.title, root: p.workspaceRoot })) }, null, 1));
if (!really) process.exit(0);
for (const project of mine) {
  const projectId = project.id ?? project.projectId;
  for (const thread of threads.filter((t) => (t.projectId ?? t.project?.id) === projectId)) {
    await dispatch(cookie, { type: "thread.delete", commandId: uuid(), threadId: thread.id ?? thread.threadId });
    console.log("deleted thread", thread.title);
  }
  await mutateProject(cookie, { type: "project.delete", commandId: uuid(), projectId, force: true });
  console.log("deleted project", project.title);
}
