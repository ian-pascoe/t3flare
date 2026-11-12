# Vendored from cloudpid

Copied unchanged from `~/src/cloudpid` (the owner's durable-pi product, unpublished) at commit
`93ba45a326f77f2575b53b29e73f5db313d21360` (tools step, OD-T10): `packages/config`, `packages/protocol` and
`packages/mcp`, under their own names (`@cloudpid/config`, `@cloudpid/protocol`, `@cloudpid/mcp`), so a sync is a copy.

- The only local edit: `vitest` 5.0.5 in each `package.json`'s devDependencies (cloudpid hoists it from its root).
- Do not edit these files here. A change goes to cloudpid first; then copy the three directories again at the new commit
  and update the commit above and `docs/upstream-fragility.md` (U44).
- Only the MCP Worker (`apps/mcp-worker`) imports `@cloudpid/mcp` (the SDK must stay out of the agents and Environment
  bundles: `apps/mcp-worker/test/sdk-isolation.test.ts`). The Environment Worker may import `@cloudpid/mcp/types` (types
  only).
