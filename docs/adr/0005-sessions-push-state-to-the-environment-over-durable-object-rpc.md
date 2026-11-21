# Sessions push state to the Environment over Durable Object RPC

Each Durable agent thread is a pi-durable Harness in its own Session DO. The Session pushes its committed changes to the Environment DO by calling it over DO RPC, coalesced to about every 300 ms while streaming (t3 shows streamed text at most every 400 ms). The adapter turns them into t3 provider events by diffing pi-durable's committed state, not from an event feed. On a sequence gap, or when no provider session is open, the adapter pulls a snapshot and re-diffs from a cursor it stores. Commands (submit, steer, abort, answer) go the other way as RPC calls. The Session is the durable party, so it is the one that wakes the other, and nothing is held open.

Rule: never call a Session from inside a SQL transaction. `storage.transaction()` closes the input gate, so a callback would deadlock.

## Considered Options

- **An outbound WebSocket per active Session** (a socket from each Session): pins the Environment DO, counts against the 6 outgoing connections, and needs reconnect logic on both ends.
- **Hosting the Harness inside the Environment DO**: every agent in one 128 MB single-threaded isolate.

## Refinement (2026-11-21): a push goes out from the Session's alarm

A Durable Object's subrequests count against the newest of its incoming requests that is not yet done, and a request stays not done while any of the object's work is pending, until the next request arrives (workerd `io-context.h`, `IoContext_IncomingRequest`). A push sent from a timer therefore nested one level below the Environment's last call into the Session, and the Environment's calls made during that push nested one level below the push: two levels for each command's round trip. On prod, a thread's next turn then failed with "Subrequest depth limit exceeded" from every call the Environment made: `open`, `submitTurn`, its git processes, and the model calls that the turn's Session made. This is the failure step 4a met with pushed process output ([ADR-0015](0015-cli-agents-run-through-platform-exec-codex-in-managed-mode-claude-and-opencode-over-acp.md)).

The Session now sends every push from its alarm (`apps/agents/src/session/alarmPlan.ts`). The coalescing timer only arms the alarm for now. An alarm is a request of its own, at the top of no chain, so each push starts again at the top, and so does every call the Environment makes during it. An alarm armed for a push before housekeeping is due only pushes. The Environment's side is unchanged.

A new request to the Environment, such as a client opening a socket or reading over HTTP, becomes its newest request and starts the depth again from the top. A client sending every turn on one long-lived WebSocket starts nothing again, and that is how the Owner's prod thread failed. `apps/environment/scripts/pushdepth.ts` sends its turns that way. On the `pushdepth` stage, with prompt suggestions on, the Session as it was failed every turn from the third on with prod's errors (`The Model endpoint "commissary" failed (HTTP 500)`, then `did not answer open`). With pushes sent from the alarm, all 12 turns completed.
