// The codemode sandbox Worker (ADR-0027; cloudpid's apps/codemode-sandbox, its ADR-0005): pi-codemode's QuickJS sandbox
// Durable Object, one object per Session (`RemoteCodemodeSandbox` in the Session DO picks it by the Session's name). A
// Worker of its own so a script that computes holds this isolate's thread, not the Session's. No public URL and no
// routes: the agents Worker's Durable Object binding (by this Worker's script name) is the only way in.
//
// Bundled by alchemy, not by our Rolldown build (ADR-0020's refinement): pi-codemode imports `quickjs-wasi/quickjs.wasm`,
// which alchemy's bundler uploads as a compiled module by its default rule; this Worker imports nothing of t3.
import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";

/**
 * The sandbox with t3flare's limits. Interrupt budget: pi-codemode's default (100 000 polls, about 10 s of a tight loop on
 * Cloudflare). Memory: 16 MiB per VM, not 32 (review M6): every VM in an isolate shares its 128 MB, so a few Sessions'
 * scripts at 32 MiB could reset the isolate and fail every script in it.
 */
export class CodemodeSandbox extends CodemodeSandboxDurableObject {
  protected override maxMemoryLimitBytes = 16 * 1024 * 1024;
}

/** Reached over RPC only. */
export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
