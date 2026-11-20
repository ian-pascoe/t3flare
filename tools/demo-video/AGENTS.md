# tools/demo-video

t3flare's launch video: a Remotion project with its own pnpm workspace and lock, outside the root workspace.

## Rules

- Run pnpm here only as `mise exec -- pnpm …` from this directory, after `mise trust`. A shell started at the repo root
  carries the root's `NPM_CONFIG_WORKSPACE_DIR`, and a bare `pnpm add` would then edit the root `package.json` and lock.
- Before a pull request that touches this folder, run `mise exec -- pnpm run check` here. The root `pnpm run check`
  does not cover it.
- Footage (`public/footage/`) and `public/music.mp3` are never committed: `pnpm capture` re-records the footage, and
  a track carries its own licence.
- The capture never reads or prints a credential: pairing codes go through a 0600 file and are deleted once typed.
- Every claim on screen has a source in README.md's claims table; change the two together.
