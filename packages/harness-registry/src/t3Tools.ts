// t3's own MCP tools a Durable agent is not offered (ADR-0022). CLI agents get t3's whole list, as stock t3 hands it.

/**
 * The T3 tools that cannot work for a Durable agent here; every other tool t3 lists for the thread is offered, as stock
 * t3 offers it (owner, 2026-11-12, back to stock: a short denylist instead of an allowlist). `prefix_*` is a family.
 * - `t3_attachment_*` and `t3_thread_send_attachments`: an upload URL for a shell's `curl`, and sending what it uploaded.
 * - `device_*`: the device hub is host-bound and locked off (ADR-0023, ADR-0024).
 * - `t3_worktree_*`: t3's worktree handoff runs git the process router has not been audited for.
 * `html_*`, `preview_*` and `t3_preview_*` are offered: t3's renders and server browser run in Browser Run (G11,
 * ADR-0031), and t3 itself offers `preview_*` only while the owner's agent browser access setting is on.
 * The link tools (`t3_environment_link`, `t3_environment_unlink`) are offered: the Outbound link is t3's own (SPI-1061,
 * ADR-0029).
 */
export const T3_TOOL_DENYLIST: ReadonlySet<string> = new Set([
  "t3_attachment_*",
  "t3_thread_send_attachments",
  "device_*",
  "t3_worktree_*",
]);

const prefixOf = (pattern: string) => pattern.slice(0, -1);
const isFamily = (name: string) => name.endsWith("*");

/**
 * Whether a tool name, or a family `prefix_*` as t3's text names one, is denied: a family is denied when it could
 * name a denied tool.
 */
export const isDeniedT3Tool = (name: string): boolean =>
  [...T3_TOOL_DENYLIST].some((denied) => {
    if (!isFamily(name)) return isFamily(denied) ? name.startsWith(prefixOf(denied)) : name === denied;
    const family = prefixOf(name);
    return isFamily(denied) ? prefixOf(denied).startsWith(family) || family.startsWith(prefixOf(denied)) : denied.startsWith(family);
  });
