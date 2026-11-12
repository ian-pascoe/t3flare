# Two Workers: environment and agents

The `environment` Worker holds the front door, the Environment DO and the t3 web client's assets. The `agents` Worker holds the Session DOs, Workspace DOs and the Container binding. Durable Objects of one Worker can share an isolate and its 128 MB, and a Session waking should not pay t3's startup cost (the 1 s startup limit is t3's to spend). The two Workers also deploy differently: Sessions survive resets by design and use the default deferred update, while the environment Worker waits up to about 30 minutes (ADR-0004).

## Refinement (step 2a, R5)

Measured in step 2a (`docs/steps/step-2a/m3-memory.json`): the Workspace DO's isomorphic-git work fits the agents isolate. A checkpoint capture of a 2,000-file working tree (the guard) peaks at 40–52 MB of heap above the baseline in V8 and releases it; a checkpoint diff or a stale status patch peaks under 20 MB. Deployed, a 2,000-file capture took 2.3–2.9 s with no memory errors. Two live Sessions and one capture fit in 128 MB with room; the guard stays at 2,000 tracked files and 16 MB of packs, and no third Worker is needed.

## Refinement (tools step): four Workers

A stage now runs four Workers:
- **environment**;
- **agents**;
- **codemode** (`t3flare-codemode-<stage>`): pi-codemode's sandbox Durable Object, so a computing script never holds the Session's isolate (ADR-0027);
- **mcp** (`t3flare-mcp-<stage>`): the MCP engine, with no bindings and strictly public fetch, so the SDK's heap and every outbound MCP request stay apart from t3 (ADR-0028).

A fifth, the admin forwarder (`t3flare-admin-<stage>`) that gave the harness panel its own host, was removed (owner, 2026-11-12, back to stock; ADR-0026).

A stage-only fixture MCP Worker (`t3flare-mcpfixture-<stage>`) is deployed on test stages only. `stage.ts` orders the deploys, and prod's CI deploys the same stack.
