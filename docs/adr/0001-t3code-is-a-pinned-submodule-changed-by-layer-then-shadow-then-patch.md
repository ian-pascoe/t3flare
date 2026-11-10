# t3code is a pinned submodule, changed by Layer, then Shadow, then Patch

t3flare runs t3code's own server code so that stock t3 clients and Peer links work unchanged. We take t3code as a git submodule pinned to a release tag, and our packages import its modules. A change to t3's behaviour is made, in order of preference:

1. our own Layer for one of t3's Effect services;
2. a **Shadow**: a bundler alias that replaces a whole module;
3. a **Patch** file.

Most of the Node-only code (`server.ts`, the platform Layers) is never imported, because we write our own composition root. The outer pnpm workspace config is generated from t3's, because pnpm reads the catalog, overrides and `patchedDependencies` only at the root. We use pnpm, not Bun: a second copy of `effect` breaks schema decoding.

## Considered Options

- **A straight fork with our app in-tree**: no workspace mechanics, but edits in place cost nothing, so the fork drifts silently.
- **A vendored subtree**: easier to hack on, harder to rebase.
