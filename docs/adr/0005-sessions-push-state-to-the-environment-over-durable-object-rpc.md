# Sessions push state to the Environment over Durable Object RPC

Each Durable agent thread is a pi-durable Harness in its own Session DO. The Session pushes its committed changes to the Environment DO by calling it over DO RPC, coalesced to about every 300 ms while streaming (t3 shows streamed text at most every 400 ms). The adapter turns them into t3 provider events by diffing pi-durable's committed state, not from an event feed. On a sequence gap, or when no provider session is open, the adapter pulls a snapshot and re-diffs from a cursor it stores. Commands (submit, steer, abort, answer) go the other way as RPC calls. The Session is the durable party, so it is the one that wakes the other, and nothing is held open.

Rule: never call a Session from inside a SQL transaction. `storage.transaction()` closes the input gate, so a callback would deadlock.

## Considered Options

- **An outbound WebSocket per active Session** (cloudpid's session socket): pins the Environment DO, counts against the 6 outgoing connections, and needs reconnect logic on both ends.
- **Hosting the Harness inside the Environment DO**: every agent in one 128 MB single-threaded isolate.
