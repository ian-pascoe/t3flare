# An Environment restart ends running turns

At startup t3's recovery assumes every provider process died: it cancels open runs and `RestartContinuation` re-prompts the agent. A Session DO keeps running across an Environment restart, but we accept t3's semantics rather than patching recovery to re-attach. On re-open, the Durable agent's adapter aborts the Session's in-flight turn so both sides agree. A restart therefore costs a re-prompt, never the conversation. Restarts are kept rare: the runtime stays up during runs (ADR-0003), and the environment Worker deploys with a deferred `max_delay` of about 30 minutes, so most deploys land when it is idle.

## Considered Options

- **Patch t3's recovery to re-attach live turns**: a patch in a ~1,000-line core file that changes often. Ask upstream for a "turns survive host restart" capability instead.

## Refinement (step 2a)

Proved with tools (`docs/steps/step-2a/m5-restart.json`, five runs in a row, and from the desktop client): a restart while the agent's `bash` runs ends the run as cancelled, the Session's turn is aborted when its next push is answered with the turn as an orphan, and `RestartContinuation` starts a new run that completes. A restart while an approval waits gets no continuation (t3 expires the request as `not_resumable`); the Session aborts the turn and withdraws the request at its next liveness push (within about 60 s). An aborted tool call's Container process is not always killed: in one desktop run the continuation found the previous `sleep` still running. Part 2 should kill the call's process group on abort.
