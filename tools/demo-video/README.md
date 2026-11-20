# t3flare launch video

A 40-second launch video for X (1920 x 1080, 30 fps, silent-safe), made with [Remotion](https://www.remotion.dev)
from real T3 Code desktop footage recorded against a throwaway t3flare Stage.

```sh
mise trust && mise exec -- pnpm install
mise exec -- pnpm dev        # Remotion Studio
mise exec -- pnpm render     # out/t3flare-launch.mp4 (H.264, CRF 16)
mise exec -- pnpm still      # out/poster.png
mise exec -- pnpm check      # typecheck, lint, and the compositions load
```

Until a shot is recorded its scene shows a placeholder naming the command that records it.

## Recording the footage

Prerequisites: T3 Code (Nightly) in `/Applications`, `agent-browser`, `ffmpeg`, AeroSpace (the window is parked on
workspace 9; `T3FLARE_DEMO_WORKSPACE` changes it), and a Deployment you can deploy a test Stage of.

1. Deploy the Stage: `pnpm --filter @t3flare/environment run deploy demo` from the repo root.
2. `mise exec -- pnpm capture launch` starts an isolated T3 Code beside your own: its own `HOME` and `T3CODE_HOME`
   under `~/.cache/t3flare-demo` (`T3FLARE_DEMO_DIR`), a mock keychain, auto-update off, and a `scutil` shim that
   labels the laptop "MacBook Pro". Your own app is never restarted or touched.
3. Set it up once, off camera:
   - Pair it with the Stage: `node scripts/stage.ts run demo mint-code <0600 file>` in `apps/environment`, then
     Settings → Environments → Add environment, with the Stage's host and the code. Delete the file.
   - Open `#/welcome#agents:<cloud environment id>` and turn on OpenCode, Pi and Pi Durable.
   - Add the fixture repository as a project on the cloud (Add project → t3flare → Git URL), and on the laptop from a
     local clone whose `origin` is the same URL (Add project → MacBook Pro → Local folder). Reload once, so the
     composer's "Run on" lists both.
4. `mise exec -- pnpm capture shot <name>` records one shot into `public/footage/<name>.mp4` with `<name>.json`, the
   times of its events; `all` records every shot. The scenes trim to those times; after a re-take, update the
   Durable scene's `restartAt`, `noticeAt` and `doneAt` from `durable-restart.json`.
5. Once the video is approved: `pnpm capture stop`, `pnpm --filter @t3flare/environment exec node scripts/stage.ts destroy demo`,
   and remove `~/.cache/t3flare-demo`.

| Shot | Beat | What it records |
| --- | --- | --- |
| `hook-turn` | 1 Hook, 2 Turn | A Pi Durable turn on the cloud: prompt sent at 1 s, worktree, tool calls, summary |
| `switcher` | 3 Payoff | The composer's "Run on" listing MacBook Pro and t3flare |
| `durable-restart` | 4 Durable | A turn inside a bash call; `POST /_t3flare/restart`; t3's cancel and resume notices; the turn finishing |
| `providers` | 5 CLI agents | The cloud's model picker: Codex, Claude, OpenCode, Pi, Pi Durable |
| `remote-task` | 6 Laptop link | Not recorded yet: the scene shows its placeholder |

## Claims on screen

| Claim | Source |
| --- | --- |
| The stock T3 Code clients; a cloud Environment you own | README.md, What you get |
| Restart mid-turn. It carries on. / A restart costs a re-prompt, never the conversation. | ADR-0004, and the `durable-restart` footage |
| Your model endpoints. No vendor keys in the box. | README.md, CLI agents; ADR-0013 |
| From $5/mo on Cloudflare, + your model usage; heavy use ≈ $35/mo | docs/cost.md |
| The phone's "Done: t3flare-fixture" alert | t3code/infra/relay/src/agentActivity/agentActivityAlerts.ts |

## Before publishing

- Check every frame for the Owner's email, the Stage's workers.dev host, the Access team domain, endpoint URLs, local
  paths and other projects. The new-thread palette shows the laptop project's local path: keep it out of shots.
- Music: "Trap Hype Beat" by DELOSound (https://pixabay.com/music/trap-trap-hype-beat-471128/), under the Pixabay
  Content License: commercial use, no attribution required. Download it as `public/music.mp3`; `<Music startAt>` in
  `src/Launch.tsx` lines its drop up with the lid closing at 0:04.5. The track is registered with YouTube's Content ID,
  so a YouTube upload may be claimed; X is unaffected.
- Remotion's licence: free for individuals and companies of up to three people; others need a company licence.

Alt text for the post: "A laptop running T3 Code closes; the same coding agent keeps working in a cloud Environment on
Cloudflare, survives a restart, and offers Codex, Claude, OpenCode, Pi and Pi Durable. t3flare: deploy your own."
