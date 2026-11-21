# Copied code is t3flare's own, with no upstream to sync

Status: accepted (2026-11-21). Replaces OD-T10 (the MCP core vendored unchanged and synced by copying) and
[ADR-0028](0028-mcp-tools-reach-agents-through-the-environments-mcp-host.md) §2's "vendored" engine.

Much of t3flare began as copies from the owner's other durable-pi project: the MCP core and its protocol and config
packages, kept unchanged in `vendor/` so that a sync could be a plain copy, and many files elsewhere whose headers named
the commit they came from. That project goes its own way now and will diverge, so t3flare no longer follows it.

1. **The MCP core is `packages/mcp` (`@t3flare/mcp`)**, checked like every other package: typecheck, lint and tests in
   `pnpm run check`. `vendor/` is gone. The protocol and config packages were pruned to what t3flare reaches: the
   elicitation form schemas went into `@t3flare/mcp` (`elicitation-form.ts`), the Container prices into
   `apps/environment/src/harness/containerCost.ts`, and the rest was deleted.
2. **No upstream.** A fix the other project makes is ported by hand when t3flare wants it. No header names where a file
   came from, and no doc says to compare with or sync from that project.
3. **Its names are t3flare's.** The Container image's supervisor, memory guard and shared directory, the MCP client's
   name and its internal headers, and the messages agents and servers see all say t3flare. For one release the image
   keeps a copy of `/usr/local/share/t3flare` at its earlier path, which the commands' environment
   (`apps/sandbox-image/src/env.ts`) still names: a Workspace Container started on the previous image keeps running
   after a deploy, since Containers run by Durable Objects take no rollout. The next release moves `env.ts` and drops
   the copy.
4. **The MCP code keeps its own TypeScript base** (`packages/mcp/tsconfig.base.json`, which `apps/mcp-worker` extends).
   Under t3's base its Effect language service rules report about 25 errors (`effectFnOpportunity`,
   `effectTryWithoutCatch`); conforming is later work.

## Considered options

- **Keep vendoring.** A sync was already not a copy: security fixes had been made in `vendor/` itself. Rejected.
- **Move the packages and keep everything.** Most of the protocol and config packages served the other project's
  product (triggers, reviews, transcripts, its settings) and nothing here reached them. Rejected.

## Consequences

- The MCP engine still carries the other project's stdio-bridge path, which always fails here (no bridge, OD-T12), and
  many comments in the absorbed code point to `docs/architecture/*.md`, which this repository does not have. Both are
  cleanup to do.
