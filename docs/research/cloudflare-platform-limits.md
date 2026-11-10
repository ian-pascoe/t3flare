# Cloudflare platform limits & Effect v4 fit: single-DO server + Containers

Research date: 2026-11-10. Target: one large Effect 4.1.2 TypeScript server (~260k LOC, many deps) inside one Durable Object (DO), serving Effect RPC over WebSocket to a few clients, SQLite storage, and on-demand Cloudflare Containers for CLI processes.

Conventions:
- Every claim cites a primary URL, with the page's "Last updated" date where the page shows one.
- Numbers marked **(calc)** are my arithmetic from cited figures.
- **UNCONFIRMED** = not verified in a primary source I could reach.
- Docs URLs are the Cloudflare developers site; source URLs are GitHub/npm.

---

## 1. Worker script size, startup, global-scope CPU

| Item | Value | Source |
|---|---|---|
| Worker size | 64 MiB **uncompressed**, Free and Paid. "There is no compressed size limit." | https://developers.cloudflare.com/workers/platform/limits/ (Last updated Oct 29, 2026) |
| Startup (global scope) | 1 second. Violation returns error 10021 "Script startup exceeded CPU time limit". | same page, "Worker startup time" |
| Measure size | `wrangler deploy --outdir bundled/ --dry-run` prints "Total Upload" (uncompressed) | same page, "Worker size" |
| Measure startup | `wrangler deploy` or `versions upload` reports `startup_time_ms`; `wrangler check startup` generates a CPU profile | same page |
| Memory per isolate | 128 MB, JS heap + WebAssembly, per isolate not per request | same page, "Memory" |

Implications:
- A 260k-LOC app plus deps must be bundled under 64 MiB uncompressed. Actual size **UNCONFIRMED**: measure with the dry-run command above.
- Top-level init (building Effect Layers/Schema, importing heavy modules) counts against the 1 s startup budget. Defer work into the first request or `blockConcurrencyWhile`. Per the page, "generating or consuming a large schema at the top level is a common cause of exceeding this limit."
- The 128 MB isolate limit covers the whole JS heap for everything the isolate holds. Exceeding it lets in-flight requests finish and creates a new isolate (same page).

## 2. Durable Objects: limits, eviction, alarms, storage, deploys

### Limits (https://developers.cloudflare.com/durable-objects/platform/limits/, Last updated Nov 7, 2026)
- CPU per request: **30 s default, configurable to 5 min** via `limits.cpu_ms` (wrangler.toml `[limits] cpu_ms = 300_000`). Applies to all objects of that DO class. Each incoming HTTP request or WebSocket message resets the budget to 30 s (footnote 4). Compute consumed between messages beyond that raises eviction risk.
- Wall time: no limit for DO RPC/HTTP while the caller stays connected. Alarm handlers: 15 min. (https://developers.cloudflare.com/workers/platform/limits/#duration)
- Memory: 128 MB per isolate (see §1). Several DOs may share an isolate and share that 128 MB, but each is billed as if allocated 128 MB (https://developers.cloudflare.com/durable-objects/platform/pricing/, footnote 5).
- Storage per DO (SQLite-backed): **10 GB** on Paid (1 GB Free; SQLITE_FULL on overflow). Account storage unlimited on Paid.
- SQL limits: max row/string/BLOB 8 MB; key+value 8 MB; 100 columns/table; 100 bound params/query; 100 KB statement length; no row-count limit beyond storage.
- WebSocket received message size: 32 MiB.
- Soft throughput: ~1,000 req/s per object ("soft limit"); overloaded errors beyond queueing.
- Outbound fetch body: 100 MiB per request body.
- Simultaneous outgoing connections: 6 per request (includes outbound WebSockets while awaiting headers).

### Lifecycle and eviction (https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/, Last updated Oct 30, 2026)
- States: active in-memory; idle non-hibernatable in-memory; idle hibernatable in-memory; hibernated (memory discarded, WebSockets stay connected); inactive (fully evicted).
- Hibernation only if all true: no `setTimeout`/`setInterval` pending; no unfinished I/O or `waitUntil` promise; no open outbound connection; no standard WebSocket API in use; no request in progress.
- Hibernatable idle objects hibernate after **10 s** of inactivity.
- Non-hibernatable idle objects are evicted after **70–140 s** of inactivity.
- Pending I/O, outbound `fetch`, RPC calls, `waitUntil`, `setTimeout`/`setInterval`, TCP sockets, outbound WebSockets and `container.monitor()` each prevent eviction for up to **15 min per operation**.
- Profiling sessions prevent eviction (not hibernation).
- Shutdown (code update, runtime update, placement) restarts the object. WebSockets are terminated on shutdown. Storage-touching in-flight HTTP/RPC requests are stopped. No shutdown hooks: "design your application to write state incrementally" (lifecycle page, "Working without shutdown hooks").

**With an open non-hibernatable WebSocket** (`ws.accept()` / standard API): the object stays in memory, eviction is blocked while the socket is open, and duration is billed for the whole connection (see §3; pricing footnote 4).

**With hibernatable WebSockets** (`ctx.acceptWebSocket`): the object can be evicted while sockets stay connected. The next message re-runs the constructor.

**Effect-specific risk:** `Effect.sleep` / Clock sleep uses `setTimeout` (`packages/effect/src/internal/effect.ts` ~L6397, tag effect@4.1.2, https://github.com/Effect-TS/effect/blob/effect@4.1.2/packages/effect/src/internal/effect.ts). A pending sleep blocks hibernation and the timer does not survive hibernation/eviction. Use DO alarms for durable timers. The default Scheduler also uses `setImmediate`/`setTimeout(0)` (`packages/effect/src/Scheduler.ts` ~L97–105, same tag). Those are transient, so probably harmless, but **UNCONFIRMED** that they never block hibernation in practice.

### Alarms (https://developers.cloudflare.com/durable-objects/api/alarms/, Last updated Apr 21, 2026)
- One alarm per DO at a time. `setAlarm` overrides the existing one. Keep your own schedule in storage and reschedule from `alarm()`.
- At-least-once execution. On an uncaught exception, retried with exponential backoff from 2 s, up to **6 retries**. Recommendation: catch inside `alarm()` and reschedule yourself.
- Only one `alarm()` runs at a time per instance.
- Constructor calling `setAlarm` can clobber the next alarm. Check `getAlarm()` first.
- Alarm handler wall time is capped at 15 min (https://developers.cloudflare.com/workers/platform/limits/#duration).

### Deploys (https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/, Last updated Oct 30, 2026)
- Default strategy is `deferred` with `max_delay` 300 s. An active object keeps its old code until it hibernates or hits the delay; then it resets to new code. Max `max_delay` 86400 s.
- `--durable-objects-code-update-mode immediate` resets active objects immediately.
- Deploy itself completes immediately; the strategy governs each active object (same page).
- Runtime updates: processes get up to 20 min to drain Workers requests and connections, including WebSockets (https://developers.cloudflare.com/workers/platform/limits/#runtime-updates). The DO lifecycle page says in-flight HTTP/RPC has up to 30 s during runtime updates. These two statements differ; treat WebSocket sessions as interruptible and reconnect-safe.

**Implication:** a deploy with a single-DO server will drop every client WebSocket once per object (immediately, or at `max_delay`). Clients must reconnect and resync.

### SQLite storage API
- `ctx.storage.sql` is the `SqlStorage` handle; `ctx.storage.transaction()` / `transactionSync` for transactions (see §7; https://github.com/Effect-TS/effect/blob/effect@4.1.2/packages/sql/sqlite-do/src/SqliteClient.ts).
- Writes past 10 GB fail with `SQLITE_FULL`. Reads and deletes keep working (https://developers.cloudflare.com/durable-objects/platform/limits/, FAQ).

## 3. Durable Objects pricing (https://developers.cloudflare.com/durable-objects/platform/pricing/, Last updated Oct 18, 2026)

Workers Paid plan (minimum **$5/month per account**, https://developers.cloudflare.com/workers/platform/pricing/):
- Requests: 1 M/month included, then $0.15 per M. Includes HTTP, RPC sessions, WebSocket messages (20:1 ratio for WS message billing, footnote 2), alarms.
- Duration: **400,000 GB-s/month included**, then **$12.50 per M GB-s**. Billable usage is rounded **up** to the next million GB-s before the rate applies (page example).
- Duration is billed for wall-clock time while the object is active or idle-non-hibernatable, charged on 128 MB regardless of usage (footnotes 4–5).
- SQL stored data: 5 GB-month included, then $0.20/GB-month. Rows read: 25 B/month included; rows written: 50 M included, then $1.00/M. Billing for SQLite storage began January 2026 (pricing page note).

Answers to the specific questions:
- **Is a non-hibernatable WebSocket billed for wall-clock?** Yes. "Calling `accept()` on a WebSocket in an Object will incur duration charges for the entire time the WebSocket is connected" (pricing page footnote 4). Hibernation API avoids this.
- Auto-response pings (`setWebSocketAutoResponse`) do not incur duration (footnote 3).

**Rough monthly cost of one 128 MB DO resident 24/7 (non-hibernating):**
- GB-s per month = 0.128 GB × seconds. 31 days = 2,678,400 s → **342,835 GB-s** (calc). 30 days → 331,776 GB-s (calc).
- Inside the 400,000 GB-s included allotment → **$0 duration** (calc). Account cost is the **$5 minimum**.
- A second 24/7 DO pushes usage to ~685,670 GB-s (calc), i.e. ~285,670 over the allotment, which rounds up to 1 M GB-s → **$12.50** (calc, per the rounding rule). Each additional such DO costs about $12.50/month once over the allotment.
- Requests are negligible for a few clients at low message rate (e.g. 1 msg/s per connection ≈ 129,600 billed requests/month per connection, calc from the 20:1 rule).

## 4. WebSocket Hibernation API (https://developers.cloudflare.com/durable-objects/best-practices/websockets/, Last updated Oct 30, 2026; API reference https://developers.cloudflare.com/durable-objects/api/state/, Last updated Sep 30, 2026)
- Recommended API. Clients stay connected while the object is evicted. Message arrival re-runs the constructor.
- **Lost on hibernation:** all in-memory state, JS closures, pending timers (`setTimeout`/`setInterval`), in-flight promises, Effect fiber state, any object not persisted to storage.
- **Kept:** the WebSocket connections, and per-socket attachments.
- **Attachments:** `ws.serializeAttachment(value)` / `deserializeAttachment()`. Structured-clone values. **Max serialized size 16,384 bytes.** Persist through hibernation while the socket is healthy. Lost if either side closes. Must call again to update.
- **Auto-response:** `state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(req, res))`. Request and response are each limited to **2,048 characters**. Answered without waking hibernating sockets, and not billed as duration.
- Max hibernating sockets per DO: "thousands of clients per instance" is the docs' wording (best-practices intro). Hard max **UNCONFIRMED**.
- Standard WebSocket API (`addEventListener` / `ws.accept()`): blocks hibernation and is billed as duration.
- Compat date ≥ 2026-04-07: `web_socket_auto_reply_to_close` auto-replies to Close frames (best-practices page).

**Effect RPC implication:** Effect's websocket RPC protocol (see §7) is written against standard socket events. Mapping it onto `webSocketMessage` / `webSocketClose` handlers and attachments is **UNCONFIRMED** and not in any source I read.

## 5. `nodejs_compat` coverage in workerd

Sources: Cloudflare Node.js compat page (https://developers.cloudflare.com/workers/runtime-apis/nodejs/, Last updated Aug 12, 2026); workerd source tree at `src/node/` (https://github.com/cloudflare/workerd/tree/main/src/node).

- Compat dates ≥ 2026-08-04 enable `nodejs_compat` and `nodejs_compat_v2` by default. Your DO on an older date needs `nodejs_compat`.
- Non-functional stubs are import-only. Methods throw or no-op. Enabled with `nodejs_compat` on or after the listed date (docs stub table).

| Module | Status | Evidence |
|---|---|---|
| `node:fs` | **Virtual FS, not host disk.** Memory-based VFS: read-only `/bundle` (your bundled modules), writable `/tmp` that is **per request** (not persistent), `/dev/null|random|full|zero`. Enabled with `nodejs_compat` on/after 2025-09-01. | https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/ (Apr 23, 2026) |
| `node:net` | **Real for outbound TCP** via `cloudflare:sockets` `connect()`. `createServer()` exists in source, but the docs describe only outbound client use. Inbound listen on arbitrary ports: **UNCONFIRMED / treat as no**. | https://developers.cloudflare.com/workers/runtime-apis/nodejs/net/ ; `src/node/net.ts`, `src/node/internal/internal_net.ts` |
| `node:http` | **Client** real with `enable_nodejs_http_modules` (auto on ≥2025-08-15). **Server** (`createServer`) requires `enable_nodejs_http_server_modules` (auto on ≥2025-09-01); without it it throws `ERR_METHOD_NOT_IMPLEMENTED`. The server is an in-runtime handler, not a TCP listener. | https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/ ; `src/node/http.ts` |
| `node:child_process` | **Stub that throws.** `spawn`, `spawnSync`, `exec`, `execFile`, `fork`, `execSync`, `execFileSync` all throw `ERR_METHOD_NOT_IMPLEMENTED`. Listed as a stub from 2026-03-17. | https://github.com/cloudflare/workerd/blob/main/src/node/child_process.ts ; stub table on nodejs compat page |
| `node:sqlite` | **Stub.** `DatabaseSync`/`StatementSync` constructors throw "Illegal constructor"; `backup()` throws. Use `ctx.storage.sql` instead. | https://github.com/cloudflare/workerd/blob/main/src/node/sqlite.ts |
| `node:os` | **Partial, minimal.** Returns defaults/empty values (`cpus()`, `hostname()`); "we don't ever expose any actual OS information". | https://github.com/cloudflare/workerd/blob/main/src/node/os.ts |
| `node:worker_threads` | **Stub.** `Worker` constructor and most methods throw `ERR_METHOD_NOT_IMPLEMENTED`; listed from 2026-03-17. | https://github.com/cloudflare/workerd/blob/main/src/node/worker_threads.ts |
| `node:module` | **Partial.** `createRequire` exists; `module.register`, `runMain`, `syncBuiltinESMExports`, `wrap` throw; `enableCompileCache` is a no-op. | https://github.com/cloudflare/workerd/blob/main/src/node/module.ts |
| `node:crypto` | **Mostly real** (hash, hmac, randomBytes, randomUUID, pbkdf2, scrypt, createCipheriv, sign/verify exist). Missing: `createCipher`/`createDecipher`, `setEngine`/`setFips`; key-object APIs partly stubbed; DSA/DH keypairs, argon2, randomUUIDv7, ed448/x448 unsupported. | https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/ ; https://github.com/cloudflare/workerd/blob/main/src/node/crypto.ts |
| `node:zlib` | **Supported** (gzip, deflate, brotli). Some source paths are gated by `nodejs_zlib` flag. | https://developers.cloudflare.com/workers/runtime-apis/nodejs/zlib/ ; `src/node/zlib.ts` |
| `node:tty`, `node:v8`, `node:dgram`, `node:readline`, `node:repl`, `node:inspector` | Stubs or partial, per the stub table (`dgram`, `inspector` from 2026-01-29; `repl`, `tty`, `v8` from 2026-03-17). `dgram` has source (UDP) but **UNCONFIRMED** whether it is usable. | nodejs compat page stub table |

Implication for the CLI design: **none of child_process, worker_threads, or node:sqlite work inside the DO.** Run CLI processes in a Container (§6).

## 6. Cloudflare Containers and Sandboxes

### Architecture and lifecycle (https://developers.cloudflare.com/containers/concepts/architecture/, Last updated Nov 9, 2026)
- Containers are reached only through a Worker → Durable Object → `ctx.container`.
- Each instance is a **Firecracker microVM** with its own kernel. Images are `linux/amd64`.
- Cold start "often in the 1–3 second range" (docs, depends on image size).
- Placement: DO and container may be in different locations.
- Shutdown: SIGTERM, wait **up to 15 min**, then SIGKILL.
- Startup work runs after `start()` plus port readiness. Exit work runs when `monitor()` settles.
- **Disk is ephemeral by default.** A sleeping container's next start gets a fresh disk from the image. Options: snapshots (`durable_object` policy) and FUSE-mounted R2.
- Inbound: end users cannot send non-HTTP TCP/UDP to a container. All traffic passes through a Worker.

### Scheduling policy (https://developers.cloudflare.com/containers/configuration/scheduling-policy/, Last updated Nov 4, 2026)
- **`default` is deprecated.** Migrate to `durable_object` (**public beta**). Per-instance image and size are chosen in DO code via `ctx.container.start({ image, instance, enableInternet })`.
- `durable_object` policy does not support `max_instances`.

### Durable Object Container API (https://developers.cloudflare.com/containers/api/durable-object-container/, Last updated Nov 9, 2026)
- Methods: `start`, `inspect`, `exec`, `snapshotContainer`, `destroy`, `signal`, `setInactivityTimeout`, `getTcpPort`, `monitor`, `interceptOutboundHttp(s)`, `interceptAllOutboundHttp`.
- `start()` returns before the port is ready; check readiness yourself.
- `exec(cmd[])` runs a binary directly (no shell). Use `["bash","-lc", ...]` for pipes. Does not start a stopped container. Processes from `exec` do not receive `start({env})` vars except `PATH`.
- `getTcpPort(port).fetch(...)` for HTTP; `getTcpPort(port).connect("ip:port")` for raw TCP (streams).
- `setInactivityTimeout(ms)`: container keeps running after the DO becomes inactive. Without it, the container stops shortly after the DO goes inactive. Must be reset after DO restart (constructor). Max **6 h** per the sandbox lifetime page (https://developers.cloudflare.com/sandbox/concepts/lifetime/, Oct 22, 2026).
- `sleepAfter` / `onActivityExpired()` are legacy (Container class). Replace with `setInactivityTimeout()` (https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-container-api/).
- `monitor()` prevents DO eviction until exit or 15 min.

### Limits (https://developers.cloudflare.com/containers/platform/limits/, Last updated Nov 2, 2026)
Instance types (vCPU / memory / disk):
- lite 1/16 / 256 MiB / 2 GB
- basic 1/4 / 1 GiB / 4 GB
- standard-1 1/2 / 4 GiB / 8 GB
- standard-2 1 / 6 GiB / 12 GB
- standard-3 2 / 8 GiB / 16 GB
- standard-4 4 / 12 GiB / 20 GB
- Custom: 1–4 vCPU, ≤12 GiB memory, ≤20 GB disk, ≥3 GiB memory per vCPU.

Account (defaults, raisable): **1,500 concurrent vCPU**, 6 TiB concurrent memory, 30 TB concurrent disk, image storage 50 GB.
Snapshots: max 20 GB; retained 30 days from creation or last restore.
Outbound HTTP body from containers: 100 MiB per request.

### Pricing (https://developers.cloudflare.com/containers/platform/pricing/, Last updated Oct 5, 2026)
- Workers Paid required. Billed every 10 ms while running.
- Memory: 25 GiB-hours/month included, then $0.0000025 per GiB-s. Provisioned size.
- CPU: 375 vCPU-minutes/month included, then $0.000020 per vCPU-s. **Active usage only.**
- Disk: 200 GB-hours/month included, then $0.00000007 per GB-s. Provisioned size.
- Egress: NA/EU $0.025/GB after 1 TB included; Oceania/Korea/Taiwan $0.05 after 500 GB; elsewhere $0.04 after 500 GB.
- Charges start at first request or manual start; stop when the instance sleeps.

**Rough cost, standard-1 running 24/7 (calc):**
- Memory: 4 GiB × 2,678,400 s = 10,713,600 GiB-s; less 90,000 included = 10,623,600 × $0.0000025 ≈ **$26.56/mo**.
- Disk: 8 GB × 2,678,400 s = 21,427,200 GB-s; less 720,000 included × $0.00000007 ≈ **$1.45/mo**.
- CPU: 0.5 vCPU × 2,678,400 s = 1,339,200 vCPU-s if fully busy; less 22,500 included × $0.00002 ≈ **$26.33/mo** at 100% CPU. Idle CPU is free.
- So a 24/7 standard-1 is ~$28/mo when mostly idle, up to ~$54/mo when fully busy (calc). The instance stops when the DO's inactivity timeout expires, which is the main cost lever.

### Sandboxes SDK (https://developers.cloudflare.com/sandbox/, Sep 30, 2026)
- `@cloudflare/sandbox` is a Durable Object + container pattern. Current version docs; 0.x is legacy.
- Commands (https://developers.cloudflare.com/sandbox/commands/, Oct 23, 2026):
  - Streaming output as server-sent events while the command runs. Disconnect sends `SIGTERM`.
  - Background processes writing to files, followed by SSE; server processes; log files.
  - Browser terminal over WebSocket (interactive shell/PTY-like).
- Files (https://developers.cloudflare.com/sandbox/files/, Oct 22, 2026): `Files` class for read/write/list/move. Snapshots of the root filesystem, automatic save via alarm, `DirectoryBackup` to R2 (one directory, beyond 30 days), `S3Mount` for R2 buckets.
- Lifetime (https://developers.cloudflare.com/sandbox/concepts/lifetime/, Oct 22, 2026): the instance runs while the DO is active (requests, alarms, streams, `accept()`ed WebSockets). After the DO goes inactive, the instance keeps running for `setInactivityTimeout` (≤6 h). **Processes inside the instance do not count as activity**, so a long build can be killed by the timeout. Stopping the instance deletes disk files unless a snapshot was taken.
- **Exact SDK method signatures: UNCONFIRMED** (I read the docs overview and guides, not the reference pages).

**Answer to "can a container run long-lived processes while the controlling DO is evicted?"** Yes, but only until the inactivity timeout (≤6 h) expires. Keep-alive via DO alarms that check work is the documented pattern. Processes do not keep the DO alive.

## 7. Effect v4 (4.1.2) fit

### Version and repo facts
- `effect@4.1.2`, `@effect/sql-sqlite-do@4.1.2` published on npm (https://registry.npmjs.org/effect/4.1.2 and https://registry.npmjs.org/@effect%2fsql-sqlite-do/4.1.2). Repository: https://github.com/Effect-TS/effect. Tags `effect@4.1.2`, `effect@4.1.3` exist.
- **`@effect/platform-cloudflare` does not exist at 4.1.2** (npm 404 for 4.1.2). First published as 4.1.3 on **2026-11-10** (npm time metadata). Peer deps: `effect ^4.1.3`, `@alchemy.run/cloudflare >=2.0.0-beta.85 <3`. Source: https://github.com/Effect-TS/effect/tree/effect@4.1.3/packages/platform/cloudflare
- `effect-smol` (https://github.com/Effect-TS/effect-smol) `main` is still at `4.0.0-beta.98` and lacks platform-cloudflare. Use `Effect-TS/effect` tags as source of truth.

### SQL on DO: `@effect/sql-sqlite-do` (yes)
- Source: https://github.com/Effect-TS/effect/tree/effect@4.1.2/packages/sql/sqlite-do (`SqliteClient.ts`, `SqliteMigrator.ts`).
- Wraps `ctx.storage.sql` (`SqlStorage`). Config `{ db?: SqlStorage, storage?: DurableObjectStorage }`. If you pass `storage`, transactions use `storage.transaction()`; without it, `withTransaction` fails with "unsupported".
- Peer dep: `effect ^4.1.2`.
- Note: storage transactions close the input gate, blocking dispatcher tasks until they finish (source comment).

### Platform layer for Workers: none at 4.1.2
- `@effect/platform-cloudflare` (4.1.3+) exports `CloudflareCluster`, `CloudflareDurableObjects` (`ClusterEntity`, `ClusterWorkflow`, `ClusterDurableQueue`, `ClusterSingleton`), `CloudflareDurableObjectPrograms`, `CloudflarePersistedQueue`, `CloudflareWorkflowEngine`, all marked **experimental**. It does **not** provide an `HttpServer` or `Socket` layer for workerd (source: `packages/platform/cloudflare/src/index.ts`, tag effect@4.1.3).
- Effect 4.1.2 generic pieces you would build on (https://github.com/Effect-TS/effect/tree/effect@4.1.2/packages/effect/src):
  - `http/HttpServer.ts`: `HttpServer` service interface (needs a runtime implementation; none for workerd in 4.1.2).
  - `http/HttpEffect.ts`: `toWebHandler` / `toWebHandlerWith` / `toWebHandlerLayerWith`. This is the bridge from a Worker `fetch(Request)` to an Effect HTTP app. Use it in the Worker `fetch` handler.
  - `http/HttpRouter.ts`.
  - `rpc/RpcServer.ts`: `layerProtocolWebsocket`, `makeProtocolWebsocket`, `makeProtocolWithHttpEffectWebsocket`, `toHttpEffectWebsocket`, `layerHttp` (protocol `"http" | "websocket"`), `layerProtocolHttp`, `layerProtocolSocketServer`.
  - `socket/SocketServer.ts`, `socket/Socket.ts`: generic socket service interfaces.
- **UNCONFIRMED:** that the Effect websocket RPC protocol runs inside workerd unmodified (it uses the standard WebSocket API, which blocks hibernation; see §2 and §4). Needs a spike.

### Effect bits relevant to DO runtime
- Effect's Clock sleep uses `setTimeout` (see §2). Durable timers need DO alarms.
- Scheduler uses `setImmediate` if present, otherwise `setTimeout(0)` (see §2).

---

## Items I could not confirm (UNCONFIRMED)
1. Actual bundle size for the 260k-LOC app (must measure with `wrangler deploy --dry-run`; budget is 64 MiB uncompressed, 1 s startup, 128 MB heap).
2. Max number of hibernatable WebSockets per DO (only "thousands" in the docs).
3. Whether Effect's websocket RPC protocol maps cleanly onto the hibernation API (attachments, `webSocketMessage` dispatch) and keeps no timers across hibernation.
4. Whether any `setTimeout`/`setImmediate` in Effect's scheduler or runtime blocks hibernation in practice.
5. Inbound TCP via `node:net` `createServer().listen()` on workerd (docs cover only outbound).
6. Exact `@cloudflare/sandbox` method signatures for streaming exec, PTY, and backup/restore (guides read, reference not read).
7. Container cold-start time for a large custom image (docs give only the "1–3 s" typical range).
8. Whether `@effect/platform-cloudflare` is compatible with Effect 4.1.2 (it requires ^4.1.3 peer dep; not tested).
9. Changelog-level details of the `durable_object` scheduling policy beta (GA date and any breaking changes after 2026-11-10): not checked.

## Sources checked (primary)
- https://developers.cloudflare.com/workers/platform/limits/ (Oct 29, 2026)
- https://developers.cloudflare.com/workers/platform/pricing/ (accessed 2026-11-10)
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/ (Aug 12, 2026), and subpages fs (Apr 23, 2026), net, http, crypto, zlib
- https://developers.cloudflare.com/durable-objects/platform/limits/ (Nov 7, 2026)
- https://developers.cloudflare.com/durable-objects/platform/pricing/ (Oct 18, 2026)
- https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ (Oct 30, 2026)
- https://developers.cloudflare.com/durable-objects/api/alarms/ (Apr 21, 2026)
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/ (Oct 30, 2026)
- https://developers.cloudflare.com/durable-objects/api/state/ (Sep 30, 2026)
- https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/ (Oct 30, 2026)
- https://developers.cloudflare.com/containers/concepts/architecture/ (Nov 9, 2026)
- https://developers.cloudflare.com/containers/api/durable-object-container/ (Nov 9, 2026)
- https://developers.cloudflare.com/containers/platform/limits/ (Nov 2, 2026)
- https://developers.cloudflare.com/containers/platform/pricing/ (Oct 5, 2026)
- https://developers.cloudflare.com/containers/configuration/scheduling-policy/ (Nov 4, 2026)
- https://developers.cloudflare.com/containers/guides/snapshots/ (Sep 30, 2026)
- https://developers.cloudflare.com/sandbox/ (Sep 30, 2026); /commands/ (Oct 23); /concepts/lifetime/ (Oct 22); /files/ (Oct 22)
- https://github.com/cloudflare/workerd/tree/main/src/node (child_process.ts, sqlite.ts, http.ts, net.ts, internal/internal_net.ts, os.ts, worker_threads.ts, module.ts, crypto.ts, zlib.ts)
- https://github.com/Effect-TS/effect/tree/effect@4.1.2 (packages/effect/src, packages/sql/sqlite-do, packages/platform)
- https://github.com/Effect-TS/effect/tree/effect@4.1.3/packages/platform/cloudflare
- https://github.com/Effect-TS/effect-smol (main)
- npm registry metadata: effect, @effect/sql-sqlite-do, @effect/platform-cloudflare
