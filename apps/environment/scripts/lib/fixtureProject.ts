// @effect-diagnostics globalConsole:off globalDate:off
// Step 3: the stage's project on the fixture repo, cloned through t3's own clone once per stage and reused, so the
// laptop's local clone of the same repo resolves to it (`RemoteDelegation.resolveRemoteProject`).
import { mutateProject, uuid, wsCall, wsFirst } from "./client.ts";

export const FIXTURE = process.env.T3FLARE_FIXTURE_REPO ?? "ian-pascoe/t3flare-fixture";
export const CLOUD_FIXTURE_ROOT = "/w/step3-fixture";

/** Every project object in the shell snapshot, wherever the snapshot nests them. */
const projectsIn = (value: unknown, found: Array<any> = []): Array<any> => {
  if (Array.isArray(value)) for (const item of value) projectsIn(item, found);
  else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.workspaceRoot === "string" && typeof record.id === "string" && typeof record.title === "string") found.push(record);
    else for (const child of Object.values(record)) projectsIn(child, found);
  }
  return found;
};

export const cloudProjects = async (cookie: string): Promise<Array<any>> =>
  projectsIn(await wsFirst(cookie, "orchestration.subscribeShell", {})).filter((project) => project.deletedAt == null);

/** The stage's fixture project (cloned on first use), as `{ projectId, workspaceRoot }`. */
export const ensureCloudFixtureProject = async (cookie: string): Promise<{ readonly projectId: string; readonly workspaceRoot: string; readonly cloned: boolean }> => {
  const existing = (await cloudProjects(cookie)).find((project) => project.workspaceRoot === CLOUD_FIXTURE_ROOT);
  if (existing !== undefined) return { projectId: existing.id, workspaceRoot: CLOUD_FIXTURE_ROOT, cloned: false };
  const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", {
    remoteUrl: `https://github.com/${FIXTURE}.git`,
    destinationPath: CLOUD_FIXTURE_ROOT,
  }).catch((error: unknown) => ({ error: String(error).slice(0, 500) }))) as { cwd?: string; error?: string };
  if (cloned.cwd !== CLOUD_FIXTURE_ROOT && !String(cloned.error).includes("exist")) throw new Error(`fixture clone failed: ${cloned.error}`);
  const projectId = uuid();
  await mutateProject(cookie, {
    type: "project.create",
    commandId: uuid(),
    projectId,
    title: "t3flare-fixture (cloud)",
    workspaceRoot: CLOUD_FIXTURE_ROOT,
    createWorkspaceRootIfMissing: false,
  });
  return { projectId, workspaceRoot: CLOUD_FIXTURE_ROOT, cloned: true };
};
