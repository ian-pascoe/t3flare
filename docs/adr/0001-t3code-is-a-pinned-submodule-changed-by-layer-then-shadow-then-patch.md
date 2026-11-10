# t3code is a pinned submodule, changed by Layer, then Shadow, then Patch

t3flare runs t3code's own server code so that stock t3 clients and Peer links work unchanged. We take t3code as a git submodule pinned to a nightly tag (ADR-0017), and our packages import its modules. A change to t3's behaviour is made, in order of preference:

1. our own Layer for one of t3's Effect services;
2. a **Shadow**: a bundler alias that replaces a whole module;
3. a **Patch** file.

Most of the Node-only code (`server.ts`, the platform Layers) is never imported, because we write our own composition root. The outer workspace's catalog, overrides and patched dependencies are generated from t3's `pnpm-workspace.yaml`, so we resolve the same versions t3 does (toolchain in ADR-0019).

## Considered Options

- **A straight fork with our app in-tree**: no workspace mechanics, but edits in place cost nothing, so the fork drifts silently.
- **A vendored subtree**: easier to hack on, harder to rebase.
