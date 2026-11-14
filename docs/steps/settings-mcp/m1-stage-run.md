# M1 (SPI-1197): what the stage run must record

M1's code and unit tests landed without a deploy. Its evidence file needs a deployed stage (`psettings`, or any
throwaway stage from `apps/environment/scripts/stage.ts`; never `prod`). Record each item below with the commit
deployed, the stage and timestamps. Never record a header value, a token or a cookie; record a secret's presence as
`{ set, setAt }` only.

## `m1-panel-safety.json`

`scripts/tools.ts panel` re-run, written as `m1-…`:

1. **The panel behaves as before**: every section loads and every write the `panel` run makes succeeds, with no
   `expectedRevision` in the body.
2. **`expectedRevision`**: a write naming the current revision applies; a stale one answers 409 and moves nothing; a
   malformed one answers 400. Skills routes included.
3. **The set-header route**: `POST /_t3flare/harness/api/mcp/secret` `{ server, value }` sets the value (the server's
   next call authenticates), is audited as `mcp.secret.set` with the mark, and moves no revision.
4. **GET the panel on a cold DO**: after the Environment has idled out (no client socket, past the idle delay), the
   first `GET /_t3flare/harness` answers 200 and lists the Open changes section, and the Workers Logs show no t3 boot
   and no error for it (the panel's Settings deps read the thread link from `provider/threadCaller.ts`, not
   `provider/adapter.ts`, so no provider module loads). Record the status, the time to first byte, and the log lines of
   that request.
5. **The smoke check every prod deploy runs** (SPI-1195 review), on this stage: run
   `node scripts/stage.ts run <stage> smoke <full 40-character commit sha>` (from `apps/environment`). Record its output: `smoke: <url> ok`,
   the health fields it prints (the build is the deployed commit, safe mode off), and no retry line naming the root
   OAuth documents (they are still t3's). It boots t3 in the Environment DO (the root documents are t3's), so run it on
   a deploy whose t3 boots: on a broken one its retries can count three failed boots and put the stage in safe mode.
