# SPI-1086: the harness panel's visual design (report)

Date: 2026-11-13. Branch `panel`, from `main` at 43a81a3. t3code is untouched (pinned at d8f3feff). Decision record:
[ADR-0026](../adr/0026-pi-durable-harness-settings-live-in-the-environment-and-an-owner-only-panel-edits-them.md)
(unchanged: this is a look, not a decision). Evidence: [`panel/`](panel/). Stage harness:
`apps/environment/scripts/panel.ts`. Throwaway stage `panel`, destroyed at the end.

Owner's complaint: "boy, that dashboard is ugly." The panel at `/_t3flare/harness` now looks like a page of T3 Code's
settings, in light and dark, on a desk and on a phone.

## Before and after

On the stage, through Access with its service token and admin token (as the scripts call it), with fixture state: four
MCP servers (Commissary listed with no tools; `fixture`, the stage's fixture MCP Worker, listed with 10 tools and one class
set by the owner; `docs`, whose listing failed; `linear`, OAuth, never signed in), a changed setting, and the audit log
those changes wrote. Full pages; desktop at 1280 css px, phone at 390 css px and 2x.

| | Light | Dark |
| --- | --- | --- |
| Before, desktop | [before-desktop-light](panel/before-desktop-light.png) | [before-desktop-dark](panel/before-desktop-dark.png) (the old page had no dark theme) |
| Before, phone | [before-phone-light](panel/before-phone-light.png) | [before-phone-dark](panel/before-phone-dark.png) (overflowed to 700 css px; resized to 1400 px) |
| After, desktop | [after-desktop-light](panel/after-desktop-light.png) | [after-desktop-dark](panel/after-desktop-dark.png) |
| After, phone | [after-phone-light](panel/after-phone-light.png) | [after-phone-dark](panel/after-phone-dark.png) |

States reached by acting on the stage's page (`panel.ts states`; desktop dark, phone light):

- [states-tests](panel/states-tests-desktop-dark.png): a test running (the Commissary button held busy for the shot) and
  a failed test's result line; [states-tests-failed](panel/states-tests-failed-phone-light.png) on a phone.
- [states-tests-ok](panel/states-tests-ok-desktop-dark.png): "Listed 10 tools in 102 ms", and the tools table with the
  owner's class override.
- [states-refused](panel/states-refused-desktop-dark.png): adding a server named `t3`, refused by the API, in the
  page's notice.
- [states-add-header](panel/states-add-header-phone-light.png): the add form with the header sign-in chosen.

The empty state (no MCP server, no audit entry) cannot be reached on a stage, where Commissary is always listed. It is
rendered locally from the same renderer with `scripts/panel-preview.ts <out> empty`:
[local-empty-desktop-dark](panel/local-empty-desktop-dark.png), [local-empty-phone-light](panel/local-empty-phone-light.png).
Every screenshot is at most 1400 px wide.

## What changed

The page is split into four modules in `apps/environment/src/harness/`:

- `page.ts`: the renderer (`renderPage`, `escapeHtml`, `pageCsp`, `McpRow`), same exports as before.
- `pageStyle.ts`: the one stylesheet, a constant.
- `pageScript.ts`: the one script, a constant.
- `pageIcons.ts`: an inline SVG sprite of 17 icons drawn for this page, used with `<use href="#i-…">`.

`panel.ts`, the routes, the API, the CSRF and Origin rules and the JSON-only rule are untouched.

**The look, echoing T3 Code's web client** (`t3code/apps/web/src/index.css`, `components/settings/`), with no code
imported:

- **Colours.** t3's tokens. Light is its zinc theme: canvas `#fcfcfc`, white cards, a `zinc-50` sidebar, `zinc-500`
  secondary text. Dark is its true-black canvas with `#121212` cards, `neutral-400` secondary text and 8% white borders.
  The accent is t3's primary, `oklch(0.488 0.217 264)` in light and `oklch(0.571 0.21 264)` in dark. It marks only
  primary actions, switches that are on, the current section and focus. Green, red and amber mark state only: connected,
  error, signed out, and a tool's read or write class.
- **Shape and type.** t3's radii: 0.5rem for controls and 0.75rem for groups. t3's system stack
  (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui`) with `ui-monospace` for names and URLs. t3's settings
  scale: a 20px page title, 16px semibold section titles, 14px row titles, 12px descriptions, and 11px metadata (t3's
  `2xs`).
- **Layout.** A quiet sidebar lists the five sections, each with an icon and a count. MCP servers shows a red dot when
  one is failing. The section in view is marked as you scroll. On screens of 860px or less, the sidebar becomes a sticky
  top bar with a row of tabs you can scroll sideways. Each section is a title over one grouped card with divided rows,
  as in t3's `SettingsSection` and `SettingsRow`.

**Sections and states:**

- **Extensions.** The adjustable extensions (code mode, tool search, offered tools) come first. A switch saves as soon
  as it changes; a setting enables its Save button once edited. The core extensions follow in a compact "Core, always on"
  group, each with a lock and its lock reason (shown to screen readers, and as a tooltip). Every field is drawn from the
  registry's schema: a number with its minimum and maximum, a select, a checkbox. A locked extension's settings, if one
  ever has any, are shown disabled.
- **MCP servers.** One card per server, headed by its name, Commissary or Direct, a status pill (Connected, Error, Not
  listed yet, Disabled), its URL and an enable switch. Below that come its facts: tool count, Exposure, when it was last
  listed, and its sign-in (none; header name with "set" and the fingerprint; or OAuth signed in or out). The last error
  sits in a red callout, and refused tools in an amber one. The actions are Test (busy while it runs, then a result line,
  green or red), Sign in (the primary button while signed out) and Remove. The tools table shows each tool's class as a
  read or write tag, whether the class is the tool's own hint or "set by you", and Mark read/write and "Use its hint"
  buttons. It opens by default for 12 tools or fewer. Empty: "No MCP servers", with a pointer to the form.
- **Add a server.** Labelled fields with hints. The sign-in is three radio cards: OAuth, Header, None. The header name
  and value appear only for Header, and are disabled otherwise so their validation does not block the other kinds. The
  name pattern is now escaped for the `v` flag that browsers use for `pattern` (the old `[a-z0-9-]` was an invalid
  pattern there, so it checked nothing).
- **Skills.** A placeholder: "Skills aren't here yet" (SPI-1001).
- **Status.** Key and value rows. ISO times read as times.
- **Audit log.** A table of when, who, action, target and change. The change is clamped to three lines.
- **Feedback.** One notice under the title: green for a sign-in started, red (`role=alert`) for a refusal or a network
  failure, with the API's own reason, and a dismiss button. The old page dropped network errors and showed a test's raw
  JSON.
- **Times** are rendered in UTC; the script rewrites them into the reader's zone and keeps the UTC time as a tooltip.

**On a phone** (≤ 640px): inputs are 16px so iOS does not zoom, controls are at least 36–44px tall, the add form is a
single column, and the tools and audit tables stack into one block per row. The tools table puts the tool's name over
its class tag and its buttons.

**Accessibility.** There is a skip link. Each section is a `section` with its `h2`, and there is one `h1`. Every input
has a label, and every button has text or an `aria-label` (for example "Mark fixture_echo as write"). The switches are
`role=switch`. A visible focus ring in the accent colour. All text is at least 4.5:1, except the disabled Save. The
icons are decorative (`aria-hidden`). The page honours reduced motion and has a forced-colours fallback.

## Constraints kept

- **Server-rendered.** No framework and nothing third-party: no font, script, CDN or image. Icons are inline SVG.
- **CSP unchanged in shape.** `style-src` and `script-src` are each one SHA-256 hash, and there is no `'self'`,
  `unsafe-inline` or `unsafe-hashes`. The page has no `style` attribute and no inline handler, which the new test
  asserts. On the stage the styled page loads under the served CSP (the after screenshots).
- **Escaping.** Every string that is not a literal still goes through `escapeHtml`. That includes the newly shown header
  name and fingerprint. A stored `enabled` that is not a boolean (the registry does not type-check it) is no longer
  interpolated raw. The script writes server answers with `textContent` only.
- **The API.** Same routes, bodies and headers. The script still sends `x-t3flare-csrf` from the meta tag, JSON only.
  The old tests (`harnessPanel.test.ts`, 13) pass unchanged.

## Tests

`apps/environment/test/harnessPage.test.ts` (10) renders the fixture state (`test/fixtures/harnessPage.ts`) and parses
its tags:

- A file snapshot of the markup, `test/__snapshots__/harnessPage.html`, with the style and script bodies left out.
- The markup is well formed, and its ids are unique.
- The navigation links every section, in order, and each section has its heading.
- Every field and button has a name.
- Every server state, the class override and the refused tool are drawn.
- The add form has its three sign-in kinds, with the header fields hidden.
- The extension forms are drawn from the schemas.
- The empty states.
- The CSP limits: one script, one stylesheet, no `style` attribute or `on*` handler, and `<use>` only to the sprite.
- Hostile strings are escaped in every `McpRow` field, the audit, the status and the CSRF token.

I mutation-checked the tests. Dropping an `aria-label`, or the escaping of an audit caller or of `enabled`, fails them.
`pnpm run check` passes (32/32).

## Design decisions (made unattended)

- **Pinned look, no concept roll.** The brief named the visual world (T3 Code's), so the impeccable skill's direction
  round was skipped as a pinned direction (`seed: none (pinned)`). It is an Operate surface, built code-led. As a
  subagent with the owner away, I wrote no PRODUCT.md, DESIGN.md or surface brief into the repo; this report holds the
  direction.
- **One page with anchors, not tabs.** On a phone the owner can scroll through everything, and a link can open any
  section. No client routing.
- **Switches save at once; settings need Save.** t3 saves its settings on change. A number field saved on every
  keystroke would audit noise, so settings keep a Save button that is enabled only once you edit.
- **Hue 264.** The brief says "purple". t3's primary is `oklch(… 264)`, a blue-violet, so the panel uses exactly that to
  sit beside it, rather than a purer purple.
- **11px metadata.** The impeccable detector flags text under 12px. It is used only where t3 uses its `2xs`: ids,
  counts, table headers, pills and the clamped audit JSON. Its other finding ("cramped padding" on `.group`) is a false
  positive: the padding is on each row inside the group.
- **Test-running shot.** The stage's tests finish in milliseconds, so for that one shot the Commissary button is held
  in the state the script sets during a test (`aria-busy`, "Testing…"). Every other state is a real result.

## Code review

I reviewed the whole diff against the brief's constraints, looking at every interpolation in `page.ts`. Fixed in the
review:

1. A non-boolean `enabled` could reach `aria-checked` raw. It is now `=== true`, with a test.
2. A locked extension's settings were no longer drawn. They now show disabled, as before.
3. On a phone the empty save note added a gap before Save. It is now hidden when empty.
4. The brand icon took the sidebar's text style. Its selector is now scoped.

Left as is:

- After a test, the server's pill and tools update only on reload. The result line says so.
- The header pattern is now enforced (it was not before). It matches the API's own rule.

## Stage

I added `panel` to `STAGES` and deployed it first with main's renderer for the before shots, then with the branch's. The
last deploy, of the branch head, re-took the after shots. I destroyed the stage at the end (alchemy: 9 resources
deleted). Commands are in the header of `scripts/panel.ts`.
