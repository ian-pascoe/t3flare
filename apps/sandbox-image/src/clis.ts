// The CLI agents the Workspace image carries (step 4a, plan §6): fixed versions, changed only by a commit and a
// deploy (ADR-0024: install and update are refused). The Dockerfile's ARGs equal these (test/clis.test.ts), and each
// pinned version satisfies t3's compatibility manifest at the pin (apps/environment/test/cliManifest.test.ts): a nightly
// that raises a minimum fails with "bump the CLI in clis.ts".
export const CLIS = {
  codex: {
    version: "0.167.2",
    /** The release tarball `codex-x86_64-unknown-linux-musl.tar.gz` of `rust-v<version>`. */
    sha256: "8246e846c550ea21197fcc4067bc270dca895e94ea42ed6a282e6f4e0125b15f",
  },
  pi: {
    version: "1.5.2",
    /** npm's package, locked with its dependencies in image/cli/package-lock.json. */
    package: "@earendil-works/pi-coding-agent",
  },
} as const;
