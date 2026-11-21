// @effect-diagnostics globalDate:off extendsNativeError:off
// GitHub Actions as an in-app Update uses it (ADR-0037; in-app updates plan D4, D5, D9): dispatch one of t3flare's own
// workflows on `main`, find the run that dispatch made by its `run-name`, read the run, and name its failed step. Every
// request takes a fresh token from `token()` (the DO's minter, with `UPDATE_DISPATCH_GITHUB_PERMISSIONS` on the update
// target's repository), uses it, and drops it.
//
// The dispatch does not ask for the run's id: the REST reference does not document `return_run_details` (D9, rejected).
// Each Update's workflow names its run `<kind> <update id>`; the run is the workflow's `workflow_dispatch` run created
// since the dispatch whose title (`display_title`, the run's `run-name`) is that name.

const API = "https://api.github.com";
/** How long one request to GitHub may take. */
const REQUEST_TIMEOUT_MS = 15_000;

export type ActionsFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface UpdateRepo {
  readonly owner: string;
  readonly name: string;
}

/** `owner/name`, or undefined for anything else. */
export const updateRepoOf = (value: string | undefined): UpdateRepo | undefined => {
  const match = value === undefined ? null : /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(value.trim());
  return match === null ? undefined : { owner: match[1]!, name: match[2]! };
};

export interface WorkflowRun {
  readonly id: number;
  readonly url: string;
  readonly status: string;
  /** Set once `status` is `completed`: `success`, `failure`, `cancelled`, `timed_out`, … */
  readonly conclusion: string | null;
  /** Its status says it left the queue (review A10: `run_started_at` can be its creation, so the record times it). */
  readonly started: boolean;
}

/** The statuses of a run still waiting its turn (the `bump` group's queue, a runner, an approval). */
const WAITING = new Set(["queued", "waiting", "pending", "requested"]);

export class ActionsError extends Error {
  override readonly name = "ActionsError";
}

interface RunJson {
  readonly id: number;
  readonly html_url: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly name?: string;
  readonly display_title?: string;
}

const runOf = (json: RunJson): WorkflowRun => ({ id: json.id, url: json.html_url, status: json.status, conclusion: json.conclusion, started: !WAITING.has(json.status) });

export interface ActionsClient {
  /** Dispatches `workflow` on `main` with `inputs`. */
  readonly dispatch: (workflow: string, inputs: Readonly<Record<string, string>>) => Promise<void>;
  /** The `workflow_dispatch` run of `workflow` titled `runName`, created at or after `since` (ms), if GitHub lists it yet. */
  readonly findRun: (workflow: string, runName: string, since: number) => Promise<WorkflowRun | undefined>;
  readonly getRun: (id: number) => Promise<WorkflowRun>;
  /** `<job> / <step>` of the run's first failed step, or its first failed job, or undefined. */
  readonly failedStep: (id: number) => Promise<string | undefined>;
}

export const actionsClient = (input: { readonly repo: UpdateRepo; readonly token: () => Promise<string>; readonly fetch: ActionsFetch }): ActionsClient => {
  const repoPath = `/repos/${encodeURIComponent(input.repo.owner)}/${encodeURIComponent(input.repo.name)}`;

  const request = async (method: string, pathname: string, body?: unknown): Promise<Response> => {
    const token = await input.token();
    const response = await input.fetch(`${API}${repoPath}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "t3flare",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const message = (() => {
        try {
          const parsed = (JSON.parse(text) as { message?: unknown }).message;
          return typeof parsed === "string" ? parsed : "";
        } catch {
          return text.slice(0, 200);
        }
      })();
      throw new ActionsError(`GitHub answered ${method} ${pathname.split("?")[0]} with ${response.status}${message === "" ? "" : `: ${message}`}`);
    }
    return response;
  };

  const workflowPath = (workflow: string) => `/actions/workflows/${encodeURIComponent(workflow)}`;

  return {
    dispatch: async (workflow, inputs) => {
      await request("POST", `${workflowPath(workflow)}/dispatches`, { ref: "main", inputs });
    },
    findRun: async (workflow, runName, since) => {
      const created = new Date(since).toISOString().replace(/\.\d{3}Z$/, "Z");
      const response = await request("GET", `${workflowPath(workflow)}/runs?event=workflow_dispatch&per_page=50&created=${encodeURIComponent(`>=${created}`)}`);
      const json = (await response.json()) as { workflow_runs?: ReadonlyArray<RunJson> };
      const run = (json.workflow_runs ?? []).find((candidate) => (candidate.display_title ?? candidate.name) === runName);
      return run === undefined ? undefined : runOf(run);
    },
    getRun: async (id) => runOf((await (await request("GET", `/actions/runs/${id}`)).json()) as RunJson),
    failedStep: async (id) => {
      const json = (await (await request("GET", `/actions/runs/${id}/jobs?filter=latest&per_page=100`)).json()) as {
        jobs?: ReadonlyArray<{ name: string; conclusion: string | null; steps?: ReadonlyArray<{ name: string; conclusion: string | null }> }>;
      };
      const failed = (json.jobs ?? []).filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out" || job.conclusion === "cancelled");
      for (const job of failed) {
        const step = job.steps?.find((candidate) => candidate.conclusion === "failure" || candidate.conclusion === "timed_out" || candidate.conclusion === "cancelled");
        if (step !== undefined) return `${job.name} / ${step.name}`;
      }
      return failed[0]?.name;
    },
  };
};
