# The Durable agent has code mode in a sandbox Worker, and its guards live in the tools

Status: accepted (tools step, 2026-11-12). Plan: [`docs/steps/tools-plan.md`](../steps/tools-plan.md) §2, with its review changelog (M2, M6, M8).

pi-durable's `codemode` tool lets the model write one short JavaScript program that calls its tools as functions. It fans out reads, reduces a large result before it reaches the Context Window, and saves model turns. Its scripts run in pi-codemode's QuickJS sandbox, which on Cloudflare is a Durable Object.

1. **The sandbox is a Worker of its own**, `t3flare-codemode-<stage>`, with one object per Session (cloudpid's ADR-0005). A script that computes holds that isolate's thread, not the Session's. It has no URL and no routes; the agents Worker's Durable Object binding is the only way in. Each VM has 16 MiB, not 32 (review M6): VMs share an isolate's 128 MB, so a few large scripts could reset the isolate and fail every script in it.
2. **Guards live in the tools, never in model-call hooks.** Our modes, approvals, plan refusals, Workspace and t3 rules are wraps on each tool's `execute`. A script's nested call runs that same guarded `execute`, so it is judged exactly as a direct call. Tests prove it per mode (`codemodeGuards.test.ts`), and the stage proves it with hostile scripts (`m2-hostile-script.json`, `m2-h6-proof.json`).
3. **Approvals inside a script survive restarts.** pi-durable journals each nested call. Our patch's `progressed` (#647) keeps a script that waits on an approval alive under `restartLimit`. A script may hold at most 8 pending asks at once; further asks wait their turn (review M8).
4. **Waits are direct-only.** `t3_thread_wait` and `t3_background_wait` are `callers: ["model"]`, as t3's Codex adapter registers them: from a script they would block it while the model works around it.
5. **The offered tools by default:** the core coding tools, `ask_user`, `codemode`, `tool_search` and t3's tools. MCP tools are deferred, reached by a search or from a script (OD-T4, option B). The panel switches it between this preset, "code mode only" and "everything direct" (ADR-0026).
6. **Nested calls show as child items** in t3's thread, built the way t3's own Pi provider shows codemode's nested calls (`parentItemId`, `parentNodeId`; U41).
7. **One rule for every card's text** (review M2), for coding, t3 and MCP cards alike (`cardText`):
   - the full text up to 16 KiB;
   - past that, the head, the size, a SHA-256 prefix and an explicit "TRUNCATED" line;
   - controls and format characters shown escaped.

   A card raised inside a script names the script.
8. **A lost sandbox ends the script** with "script failed, completed calls listed", and its card is withdrawn. pi-codemode commits a failed remote as the outcome, so the script is never silently re-run (review M6; `m0-p14-sandbox-loss.json`).

## Considered options

- **The sandbox inside the Session's isolate.** Rejected: a computing script would stall the Session's turn loop and share its memory.
- **Guards as model-call hooks** (judge the `codemode` call as a whole). Rejected: a script's nested calls would bypass them.
- **Code mode only** (option C) **or everything direct** (option A). Both are kept as presets. B keeps edits and commands direct, where the per-call cost of a script is not worth it (`m0-p3-*.json`, `m0-p4-tokens.json`).

## Consequences

- One more Worker per stage (ADR-0014's tools refinement), bundled by alchemy for its wasm (ADR-0020's tools refinement).
- Each nested call costs a sandbox-to-Session RPC and its journal commits (`m0-p3-breakdown.json`).
- A pi-durable or pi-codemode bump can change the module version or VM fingerprint and fail scripts in flight (U40). Deploy a bump with no script waiting.
- In plan mode a script's overflow output is written to a temp directory outside the guarded paths. It holds only the script's own output, never a repo file.
