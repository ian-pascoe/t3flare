# GitHub Actions dispatch & concurrency, and Durable Object deploy / PITR

Research date: 2026-11-17. Scope: four questions. (1) Which events a `GITHUB_TOKEN` push or dispatch triggers. (2) GitHub App token dispatch and its permission. (3) `concurrency` queue behaviour. (4) Durable Object behaviour on Worker deploys, WebSockets, and SQLite point-in-time recovery.

Conventions:
- Every claim cites a primary URL (docs.github.com, github.blog/changelog, developers.cloudflare.com), with the quoted sentence where it matters.
- **(derived)** = my inference from cited statements, not stated verbatim in a source.
- **UNCONFIRMED** = not verified in a primary source I could reach.

---

## 1. GitHub Actions: `GITHUB_TOKEN` pushes and dispatches

### `git push` with `GITHUB_TOKEN` does NOT trigger `on: push`
Source: https://docs.github.com/en/actions/using-workflows/triggering-a-workflow
> "When you use the repository's `GITHUB_TOKEN` to perform tasks, events triggered by the `GITHUB_TOKEN` will not create a new workflow run, with the following exceptions:"
> "For all other events, this behavior prevents you from accidentally creating recursive workflow runs. For example, if a workflow run pushes code using the repository's `GITHUB_TOKEN`, a new workflow will not run even when the repository contains a workflow configured to run when `push` events occur."

Same statement, same URL family: https://docs.github.com/en/actions/concepts/security/github_token ("When `GITHUB_TOKEN` triggers workflow runs").

Escape hatch, per the same page: "you can use a GitHub App installation access token or a personal access token instead of `GITHUB_TOKEN` to trigger events that require a token."

### `workflow_dispatch` with `GITHUB_TOKEN` DOES trigger the target
Source: https://docs.github.com/en/actions/using-workflows/triggering-a-workflow
> "`workflow_dispatch` and `repository_dispatch` events always create workflow runs."

Target workflow must declare the trigger (https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax, `on.workflow_dispatch`): "When using the `workflow_dispatch` event, you can optionally specify inputs that are passed to the workflow."

### Permissions the dispatch needs
- REST table, "Repository permissions for Actions": `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` = **write**, tokens **UAT, IAT**, additional permissions **✗**. Source: https://docs.github.com/en/rest/overview/permissions-required-for-github-apps (section "Repository permissions for \"Actions\"").
- `GITHUB_TOKEN` is an IAT: https://docs.github.com/en/actions/concepts/security/github_token: "The `GITHUB_TOKEN` secret is a GitHub App installation access token."
- The `permissions:` key name for the Actions scope: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax, table row: "`actions` | Work with GitHub Actions. For example, `actions: write` permits an action to cancel a workflow run." It links the REST permissions table above.
- **Answer:** `permissions: actions: write` on the dispatching job. **(derived)**: the dispatch route needs Actions write, the `GITHUB_TOKEN` is an IAT, and `actions` is the `permissions:` key for that scope. I did not find a sentence saying "dispatch with GITHUB_TOKEN needs `actions: write`" verbatim.
- Other `permissions:` keys are not required for this route (the REST row lists no additional permissions).
- Fork/PR context: the `GITHUB_TOKEN` is read-only in forked PRs unless the admin option is set (workflow-syntax page, "permissions" section). Not checked further.

---

## 2. GitHub App installation tokens and dispatch

### Can an IAT call the dispatch endpoint?
Yes. Same REST permissions row as §1: tokens **UAT, IAT**. Source: https://docs.github.com/en/rest/overview/permissions-required-for-github-apps

### Which App permission?
**Actions: write** (repository permission "Actions"). Additional permissions: none listed. The Contents row does not include this route; the dispatch route's listed permission is Actions only. Source: same page, "Repository permissions for \"Actions\"" table.

### Does the dispatch endpoint return the run id?
Yes, with an opt-in. Two sources, which differ in detail:

- **Changelog (primary, Feb 19 2026):** https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids
  > "Previously, this endpoint returned only a 204 No Content status code. Now, you can pass in a new optional boolean parameter, `return_run_details`, which will return a 200 OK response containing the workflow ID, API URL, and workflow URL. If you do not pass in this parameter, it will continue to return the current 204 No Content status code."
  > "If you trigger a workflow dispatch via `gh workflow run`, GitHub CLI will now return the URL for the created run along with the `gh run view` command for viewing that run."
  > "...the newest version of the GitHub CLI will also default `return_run_details` to `true`."
  (CLI v2.87.0 or later, per the same entry.)

- **REST reference (fetched 2026-11-17):** https://docs.github.com/en/rest/actions/workflows (section "Create a workflow dispatch event")
  > "* **200** - Response including the workflow run ID and URLs."
  Response schema (200): `workflow_run_id` (int64, required), `run_url` (uri, required), `html_url` (uri, required).
  The body parameters list in this section shows only `ref` (required) and `inputs` (object, max 25 properties). **`return_run_details` does not appear in it.**

**Conflict:** the reference documents the 200 response with the run id but not the request parameter the changelog names. Use the changelog's `return_run_details` wording as the request switch, and treat the exact body/query placement as **UNCONFIRMED** until the reference lists it. The 200 response schema is confirmed by the reference.

### If not returned: documented way to find the run
- Set `run-name` from an input, so the run carries a correlation id. Source: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax, `run-name`: "This value can include expressions and can reference the [`github`] and [`inputs`] contexts." Example in the same section: `run-name: Deploy to ${{ inputs.deploy_target }} by @${{ github.actor }}`.
- Then list runs and match on that name. **UNCONFIRMED:** which field of the list-runs response carries `run-name` (I did not verify the field name).

---

## 3. `concurrency` groups with `cancel-in-progress: false`

Source: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs

- Default is cancel-in-progress off: "To also cancel any currently running job or workflow in the same concurrency group, specify `cancel-in-progress: true`."
- At most one running per group: "This means that there can be at most one running job or workflow in a concurrency group at any time."
- Default queue (`queue: single`): "At most one job or workflow run can be `pending` in the concurrency group. When a new job or workflow run is queued, any existing `pending` job or workflow run in the same group is canceled and replaced."
  > "By default, any existing `pending` job or workflow in the same concurrency group will be canceled and the new queued job or workflow will take its place."

So with `cancel-in-progress: false` and the default queue: **one running + at most one pending**. A newly queued run **cancels the already-pending run**.

**Newer option: `queue: max`** (documented on the same page):
- "`max`: Up to 100 jobs or workflow runs can be `pending` in the concurrency group. When the queue is full, any additional jobs or workflow runs are canceled."
- Processing order: "processing them one at a time in order based on when each run started waiting on the concurrency group."
- "`queue: max` cannot be combined with `cancel-in-progress: true`" (validation error).

Example from the page:
```yaml
concurrency:
  group: production-deploy
  queue: max
```

So for a pending-run queue: `cancel-in-progress: false` + `queue: max` gives up to 100 pending runs, FIFO, with overflow canceled.

---

## 4. Cloudflare Durable Objects: Worker deploys, WebSockets, PITR

### 4a. What a deploy does to a running DO
Source: https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/ (Last updated Oct 30, 2026)
- "By default, Durable Objects defer code updates for up to 300 seconds (5 minutes) to give in-flight requests time to finish. An active object can keep running its current code until it hibernates or reaches this delay."
- Default strategy: "`deferred` with a 300-second `max_delay` is the default code update strategy."
- `deferred`: "If it is still active when `max_delay` is reached (86400 seconds maximum), the object resets and adopts the new code."
- `immediate`: "An active Durable Object resets and adopts the new code immediately, without waiting to hibernate."
- Deploy itself is not delayed. Source: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ ("Code updates"): "[Deploying a new Worker version] is not delayed by a code update strategy — the deployment itself completes immediately. What a code update strategy controls is when each already-active Durable Object adopts that new version."
- Configuration: `code_update_strategy` in Wrangler, or per-deploy `--durable-objects-code-update-mode immediate` / `deferred 30s` on `wrangler deploy`, `wrangler versions deploy`, `wrangler rollback`. Same code-updates page.
- `max_delay` accepts 0 to 86400 seconds with millisecond precision. `max_delay: 0` means immediate.

### 4b. WebSocket behaviour during a code update (the key answer)
Source: https://developers.cloudflare.com/durable-objects/best-practices/websockets/ (Last updated Oct 30, 2026), section "WebSocket disconnection during code updates":
> "Connections accepted with the WebSocket Hibernation API remain connected when a Durable Object adopts new code after hibernating."
> "A forced code update disconnects WebSockets attached to the running instance. This happens when a `deferred` code update's `max_delay` is reached before hibernation, or when the code update strategy is set to `immediate`. The Web Standard WebSocket API prevents hibernation, so its connections are disconnected when the code update is applied."

| Object state at deploy | Hibernation API sockets | Standard API (`ws.accept()`) sockets |
|---|---|---|
| Hibernated (not in memory) | Stay connected. Object adopts new code on next message. (Sockets survive per the quote above.) | Not hibernated, so N/A: the object cannot be hibernated while it uses the standard API. |
| Active, `deferred` | Stay connected until the object hibernates (then adopts new code). If still active at `max_delay` (default 300 s), **disconnected** as the object resets. | Object stays active (blocked from hibernating), so **disconnected at `max_delay`** (default 300 s). |
| Active, `immediate` | **Disconnected** immediately. | **Disconnected** immediately. |

Shutdown-level confirmation: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ ("Shutdown behavior"): "**WebSocket connections**: When a Durable Object shuts down, WebSocket connections are terminated automatically." Shutdown reasons include "Worker code updates that use an `immediate` code update strategy, or a `deferred` strategy that reaches its `max_delay`."

**Answer to "is the DO restarted and connections dropped promptly?"** Not promptly under the default. An active object keeps its old code and its sockets for up to 300 s, or until it hibernates. A Hibernation-API socket on an object that hibernates before the timer survives the deploy. Under `immediate`, every active object's sockets drop at once. Clients must reconnect and resync. A deploy alone does not close hibernated sockets, per the quote.

Delay options: `deferred` `max_delay` up to 86400 s (lengthens the window, not a guarantee). Deferral is best effort: "Deferral is best effort and does not guarantee that every operation finishes."

Runtime updates are a separate shutdown cause (lifecycle page): "When the Worker runtime system is being updated, in-flight requests have up to 30 seconds to complete." The Workers limits page (https://developers.cloudflare.com/workers/platform/limits/#runtime-updates) says up to 20 min for WebSockets. Those statements conflict. Earlier notes (`cloudflare-platform-limits.md`) flagged the same conflict. **UNCONFIRMED:** which applies to DO WebSockets during a runtime update. Treat sockets as interruptible.

### 4c. Point-in-time recovery (PITR) for SQLite-backed DOs
Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ (Last updated Sep 21, 2026). Same content at https://developers.cloudflare.com/durable-objects/api/storage-api/.

- Applies to: "SQLite-backed Durable Objects... to restore a Durable Object's embedded SQLite database to any point in time in the past 30 days." KV-backed objects don't have it: "Available API methods depend on the storage backend."
- **Retention: 30 days.** Quote: "offer Point In Time Recovery API which can restore a Durable Object's embedded SQLite database contents (both SQL data and key-value data) to any point in the past 30 days."
- API (confirmed signatures from the page):
  - `ctx.storage.getCurrentBookmark()`: `Promise<string>`. Returns a bookmark for the current point in time.
  - `ctx.storage.getBookmarkForTime(timestamp: number | Date)`: `Promise<string>`. "Returns a bookmark representing approximately the given point in time, which must be within the last 30 days."
  - `ctx.storage.onNextSessionRestoreBookmark(bookmark: string)`: `Promise<string>`. "Configures the Durable Object so that the next time it restarts, it should restore its storage to exactly match what the storage contained at the given bookmark. After calling this, the application should typically invoke `ctx.abort()` to restart the Durable Object, thus completing the point-in-time recovery." Returns a bookmark for the point just before recovery, so the recovery can be undone.
- Bookmarks are "lexically comparable" strings.
- Doc example (its code samples omit `await`, but the signatures return Promises, so await them **(derived)**):
  ```ts
  // restore to 2 days ago
  let bookmark = ctx.storage.getBookmarkForTime(Date.now() - 2 * DAYS_MS);
  ctx.storage.onNextSessionRestoreBookmark(bookmark);
  ```
- The PITR operation is applied on restart, so the flow is: set the bookmark, then `ctx.abort()`.
- **UNCONFIRMED:** the exact `ctx.abort()` signature (not on the pages I read); and whether the 30-day window counts from the bookmark's creation or the current time (the page says "within the last 30 days").

---

## Items I could not confirm (UNCONFIRMED)
1. The REST request parameter for dispatch that returns the run id: the changelog names `return_run_details`, but the REST reference's body parameters do not list it (§2). The 200 response schema is confirmed.
2. The list-runs response field that matches `run-name` (§2).
3. Whether `actions: write` is stated verbatim for `GITHUB_TOKEN` dispatch (§1 is derived).
4. Runtime-update WebSocket drain window for DOs: 30 s (lifecycle page) vs 20 min (Workers limits page) (§4b).
5. `ctx.abort()` signature (§4c).

## Sources checked (primary)
- https://docs.github.com/en/actions/using-workflows/triggering-a-workflow
- https://docs.github.com/en/actions/concepts/security/github_token (fetched; "When `GITHUB_TOKEN` triggers workflow runs")
- https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax (`on.workflow_dispatch`, `permissions`, `run-name`)
- https://docs.github.com/en/rest/actions/workflows (Create a workflow dispatch event)
- https://docs.github.com/en/rest/overview/permissions-required-for-github-apps (Repository permissions for "Actions")
- https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs
- https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids (primary changelog)
- https://github.blog/changelog/2026-10-02-stateless-github-app-installation-tokens-rolled-out/ (checked; not relevant to dispatch)
- https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/ (Oct 30, 2026)
- https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ (Oct 30, 2026)
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/ (Oct 30, 2026)
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ (Sep 21, 2026)
- https://developers.cloudflare.com/durable-objects/api/storage-api/ (same content)
- https://developers.cloudflare.com/workers/platform/limits/ (runtime-update statement, cited in §4b)
