// t3's own MCP tools t3flare offers its agents (ADR-0022; CLI agents through the relay, ADR-0028, SPI-1039).

/**
 * The T3 tools a Durable agent is offered (plan section 4.3). Not offered: `request_secret` and `t3_attachment_*` (their
 * purpose is a secret or an upload URL for a shell, which is a Container), `preview_*`, `html_*`, `device_*` (no browser
 * or device in the cloud), `t3_environment_link`/`unlink` (cloud-to-elsewhere links are deferred, ADR-0011), and
 * `t3_worktree_*` (t3's worktree handoff runs git the router has not been audited for).
 */
export const T3_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  // orchestration
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "t3_workflow_stop",
  "t3_background_wait",
  "create_threads",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_update",
  "t3_thread_send",
  "t3_thread_wait",
  "t3_thread_interrupt",
  "t3_pending_request",
  "t3_queue",
  "t3_thread_search",
  "t3_thread_organize",
  "t3_thread_configure",
  "t3_thread_transfer",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "run_scheduled_task_now",
  // projects
  "t3_project_list",
  "t3_project_read",
  "t3_project_create",
  "t3_project_update",
  "t3_project_delete",
  "t3_project_clone",
  "t3_thread_launch",
  // pull requests
  "link_pull_request",
  "link_pull_requests",
  "unlink_pull_request",
  "unlink_pull_requests",
  "list_thread_pull_requests",
  "watch_pull_request",
  "unwatch_pull_request",
  "read_pull_request_guide",
  "write_pull_request_guides",
  // environment
  "t3_environment_read",
  "t3_environment_links",
]);
