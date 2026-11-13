# SPI-1001 — skills and slash commands: facts

Read-only fact finding, 2026-11-13. Repo `t3flare` at `c2aaf13` (`git log -1`). Paths are repo-relative; `t3code/` is the pinned submodule. Nothing was edited except this file. No credential file was read. Every claim cites `file:line`; anything not determined is marked **UNKNOWN** with what was checked.

---

## 1. Stock t3code: how `skills` and `slashCommands` are produced

**Shape.** `ServerProviderSlashCommand` (`t3code/packages/contracts/src/server.ts:103-108`), `ServerProviderSkill` with `name, path, enabled, scope, userInvocationOnly, userInvocable, description, displayName, shortDescription` (`server.ts:110-123`), and `ServerProviderWorkspaceSnapshot {cwd, checkedAt, slashCommands, skills, models?, pending flags}` (`server.ts:125-136`). TTL 5 min (`server.ts:138`).

**Hook.** A provider instance may define `snapshotForCwd(cwd)` (`t3code/packages/provider-core/src/server/driver.ts`, `ProviderInstance`). The registry runs it per cwd and publishes the result (`t3code/apps/server/src/provider/ProviderRegistry.ts:1045-1062`); an instance without it returns providers unchanged (`ProviderRegistry.ts:1046`). `ws.ts:2491` and `ws.ts:3257` filter on the same hook.

**Per provider (stock):**

| Provider | What it reads | Where |
|---|---|---|
| **Claude** | Disk, no CLI for skills. Roots: `<configDir>/skills` (user), `<cwd>/.claude/skills` (project), each `--add-dir` `/.claude/skills`, enabled plugin skill dirs. Reads `<root>/<entry>/SKILL.md` (or a single `SKILL.md` root), parses frontmatter `name`, `description`, `disable-model-invocation`→`userInvocationOnly`, `user-invocable:false`→`userInvocable:false`. First name wins. Overrides from `.claude/settings.json` / `settings.local.json`. | `t3code/apps/server/src/provider/Drivers/ClaudeSkills.ts:631-735` (roots `:655-665`, read `:682-683`, first-wins `:711`, frontmatter `:100-104`, settings paths `:139-143`, overrides `:643-647`). `ClaudeProvider.ts:583-606` (`probeClaudeWorkspaceSnapshot`: skills from disk at `:590`; slashCommands = `COMPACT` + SDK capabilities at `:602-604`; pending when the probe fails). The capabilities probe spawns the `claude` binary: `ClaudeProvider.ts:442` onward; SDK `init.commands` parsed at `:543`. |
| **Codex** | A **CLI call**: app-server JSON-RPC `skills/list` with `{cwds:[cwd]}`. Codex's own scan roots are Codex's, not t3's (**UNKNOWN** which roots; the scope enum is `user｜repo｜system｜admin`, `packages/effect-codex-app-server/src/_generated/schema.gen.ts:8648`). | `CodexProvider.ts:706-720` (`probeCodexSkillsForCwd`, call at `:717`), `:367-398` (`parseCodexSkillsListResponse`, cwd match, maps scope/displayName/shortDescription). `CodexDriver.ts:320-332` (`snapshotForCwd` = machine snapshot + probe, 20 s timeout). Slash commands fixed: `compact`, `goal`, `feedback` (`CodexProvider.ts:947-958`). |
| **OpenCode** | A **server SDK call**: `client.skill.list({location})` and `client.command.list({location})`. OpenCode's own roots **UNKNOWN** (its source is not in this repo). | `packages/provider-opencode/src/server/driver.ts:428-429`, machine `:543-553`, cwd probe `:731-751`. Runtime inventory `OpenCodeRuntime.ts:211-212`, `app.skills` at `:835`. Mapping `status.ts:382-421` (commands get `/compact` first). |
| **pi** (`packages/provider-pi`) | A **CLI call**: pi RPC `get_commands` in a process spawned in the cwd. Entries with `source === "skill"` become skills (name with `skill:` stripped, path from `sourceInfo.path`, scope normalized `global/personal→user`, `workspace/local→project`); everything else is a slash command. `/compact` is added by T3. | `driver.ts:191-212` (`snapshotForCwd` → `discoverPiCommandsForCwd`), `status.ts:200-216` (`get_commands` at `:213`), machine discovery `status.ts:167-199` (`get_commands` at `:177`), `commands.ts:4-7` and `:45-90` (parser; skill branch `:54-75`; scope map `:30-43`). Pi decides which skills exist (its own loader, see §6); T3 `--skill` is reserved (`mcpInjection.ts:49`), `--no-skills` is a known flag (`mcpInjection.ts:72`) but T3 does not pass it. |
| **ACP registry** (generic ACP agents) | The ACP `available_commands_update` stream: names starting with `$` become skills (`scope:"agent"`, `path: acp://skill/<name>`); others are slash commands. | `packages/provider-acp-registry/src/server/probe.ts:222-248`; into the snapshot `driver.ts:266-277`. |
| **Grok** | CLI call `grok inspect --json` (honours ignored/disabled skills and plugin skills). | `packages/provider-grok/src/server/skills.ts:1`, `:94-95`. |
| **Cursor** | Filesystem scan, no ACP session: `<base>/.cursor/skills`, `.agents/skills`, `.codex/skills`, `.claude/skills`, plus `~/.cursor/skills-cursor` (system). | `packages/provider-cursor/src/server/skills.ts:1`, `:227-246`. |
| **FX** | Filesystem scan of fx's roots (workspace `.fx/skills`, `skills/`, `.opencode/skills`, `.codex/skills`, `.claude/skills`, `.agents/skills`, `.claw/skills`; home roots). | `packages/provider-fx/src/server/skills.ts:1-9`, `:28-45`. |
| **Antigravity** | Filesystem scan: user `~/.gemini/config/skills`, `~/.gemini/antigravity-cli/skills`; project `.gemini/skills`, `.agents/skills`, `.agent/skills`. `.agents/skills` is project-only. | `t3code/apps/server/src/provider/Drivers/AntigravitySkills.ts:26-33`, `:155-160`. |

**Composer (web).**
- Snapshot choice: `resolveProviderSkillsForCwd` / `resolveProviderSlashCommandsForCwd` use the cwd snapshot, else the machine list (`t3code/packages/client-runtime/src/providerSkills.ts:122-134`).
- Filters: a skill is offered when `enabled && userInvocable !== false` (`providerSkills.ts:37-42`); the slash menu shows skills only when `showSkillsInSlashMenu` is on, deduped by name (`:46-53`); a slash command with a skill's name is hidden (`:55-60`). Source kind: `/.codex/plugins/` or `/.agents/plugins/` → `app`; scope → `repo | project | personal | system | other` (`:63-~80`).
- Menu items: slash menu adds `skill:<provider>:<name>` items labelled `/skill:<name>` (`t3code/apps/web/src/components/chat/useComposerMenuItems.ts:288-292`); the `$` trigger lists skills with display names (`:310-320`).
- Insert on pick: plain text `$<name> ` (`t3code/apps/web/src/components/chat/ChatComposer.tsx:1962-1963`). Token grammar: `t3code/packages/shared/src/composerInlineTokens.ts:23-27`; `packages/shared/src/inlineSkills.ts:20-32` (`matchInlineSkills`, raw text `$name`). Placeholder "$ skills": `t3code/apps/web/src/composerPlaceholder.ts:1`.

**What is sent when a skill is picked (stock):** the text carries `$name`; expansion depends on the provider.
- **Claude:** `ClaudeAdapterV2.ts:2599-2605` and `:2796-2798` call `planClaudeSkillDispatch`. `ClaudeSkillDispatch.ts:26-57`: only the final skill becomes the message's last text block as `/<name> …` (Claude expands it natively); earlier skills are inlined as `/name`; a user-only skill (`userInvocationOnly`) also gets `[The user invoked this skill. Follow the instructions at: <path>]` (`:43-47`). The skill map is user-invocable skills from disk (`ClaudeAdapterV2.ts:5436-5447`, passed at `:12337`, `:12841`). No body is inlined by T3.
- **Codex:** `codexSkillMentionText` normalizes any currency sigil to `$` (`CodexAdapterV2.ts:449-452`); `toCodexInput` sends one `{type:"text"}` input item plus images (`:3473-3500`). No `skill` input item is built (the `type:"skill"` union exists only in the generated schema). Codex parses `$name` itself (comment `:449-452`).
- **OpenCode (v2 adapter):** `skillMentions` (`packages/provider-opencode/src/server/v2/adapter.ts:696-697`), validated against `skill.list` (`:4338-4345`), sent as `session.prompt` with the text plus `skills:[{id}]` (`:4400-4413`). **v1 adapter:** text `/name args` routes to `session.command` if it matches a loaded command (`packages/provider-opencode/src/server/adapter.ts:3026-3059`), otherwise `promptAsync`.
- **pi:** the message is sent as `type:"prompt"` (`packages/provider-pi/src/server/adapter.ts:2671`, `resolvePromptPayload` at `:2683`). T3's pi extension then transforms the input: for each `$name` with a matching `source:"skill"` command it appends a `<skill name location>` block with the SKILL.md body, frontmatter stripped (`packages/provider-pi/src/server/mcpExtensionSource.ts:268-296`; the source is a TS template string). Pi's own expansion handles only a leading `/skill:name` (see §6).

---

## 2. t3flare: providers, their snapshots, and CLI skill loading

**Drivers registered.** The Shadow `apps/environment/src/shadows/builtInDrivers.ts:9-20`: `PiDurableDriver` (Durable agent), `CodexCliDriver`, `PiCliDriver`, `ClaudeCliDriver`, `OpenCodeCliDriver`. The last two are t3's own kinds over t3's ACP adapter (`apps/environment/src/provider/cli/acpDriver.ts`; `claudeDriver.ts:30`, `opencodeDriver.ts:32`). ADR-0015 refinement "step 4b" (`docs/adr/0015-…md:45-55`). Glossary: Durable agent / Pi Durable (`GLOSSARY.md:97-105`), CLI agent and Pi CLI (`GLOSSARY.md:141-146`).

**Snapshot today (all five).** None sets `skills` or `slashCommands` and none defines `snapshotForCwd`. `grep snapshotForCwd` in `apps/environment/src` and `packages/` returns nothing. So `ProviderRegistry.ts:1045-1046` returns the machine snapshot unchanged, the client finds no `workspaceSnapshots`, and falls back to `provider.skills` / `provider.slashCommands` (`providerSkills.ts:122-134`), which default to `[]` (`packages/provider-core/src/server/snapshotProbe.ts:301-302`).

| Driver (t3flare) | Snapshot code | Result | Cite |
|---|---|---|---|
| Pi Durable | `snapshotOf` = `buildServerProvider` with models only; instance has no `snapshotForCwd` | skills `[]`, slash commands `[]` | `apps/environment/src/provider/driver.ts:40-52`, instance `:~96-110` |
| Pi CLI | same pattern | `[]`, `[]` | `apps/environment/src/provider/cli/piDriver.ts:54-62`, return `:110-124` |
| Codex CLI | `snapshotOf` without skills; no `snapshotForCwd` in the returned instance | `[]`, `[]` | `apps/environment/src/provider/cli/codexDriver.ts:119-130` |
| Claude Code (ACP) | `snapshotOf` without skills/commands; no `snapshotForCwd` | `[]`, `[]` | `apps/environment/src/provider/cli/acpDriver.ts:171-185`, return `:286-297` |
| OpenCode (ACP) | same as Claude | `[]`, `[]` | same files |

**Why (recorded).** `docs/steps/step-4a-plan.md:350`: "No `snapshotForCwd` (pi's would spawn in every project; Codex's probes skills): slash commands and skills stay G10." `docs/steps/step-4b-plan.md:261`: same, "no probe spawns in a project". Parity row `docs/parity.md:63` ("snapshot has none"; `step-2a-plan.md:116`), G10 at `docs/parity.md:148` (MCP done; skills deferred by owner, SPI-1001). Tools plan `docs/steps/tools-plan.md:622` ("Skills, slash commands: stays M, D by the owner").

**Consequence.** The composer shows no `$` skills, no skill `/skill:` entries, and no provider slash commands (other than what the client adds) for any t3flare provider.

**Do CLI agents load a repo's own skills today? (ADR-0015 "back to stock", 2026-11-12, `docs/adr/0015-…md:72-~92`)**

- **Claude Code: YES by code; runtime after back-to-stock not re-run.** Managed settings carry no skill key (`apps/environment/src/agents/acpProfiles.ts:107-118`; `permissions` `:118`). ADR-0015 `:88-89`: Claude honours the project's `.claude/` skills; `disableSkillShellExecution` removed (`:90-92`). Pre-back-to-stock evidence that a repo skill loaded: `docs/steps/step-4b/m5-hostile-claude.json:98` and `:152` ("Skill `s`: it loaded").
- **OpenCode: YES by config; runtime UNKNOWN.** System policy denies in `acpProfiles.ts:183-187` are `provider.use`, `integration.connect`, `websearch.use`; no `skill.use`. The 4b plan had `skill.use deny *` (`docs/steps/step-4b-plan.md:392`); ADR-0015 `:92-93` says it was removed.
- **Codex: no code disables skills; runtime UNKNOWN.** `grep -i skill` over `apps/environment/src/provider/cli` and `apps/environment/src/agents` finds only a comment (`acpProfiles.ts:11`). Codex runs with a fresh `CODEX_HOME` (`cliProfiles.ts:163`, `:180`), so only the repo and the image's home apply.
- **pi CLI: NO for repo skills (by pi 1.5.2 source).** The argv ends `--no-approve` (`apps/environment/src/agents/cliProfiles.ts:296`). pi's help: "`--no-approve`: Ignore project-local files for this run" (`@earendil-works/pi-coding-agent@1.5.2 dist/cli/args.js:335`; flag set `args.js:232`). In pi's package manager, project skills (`.pi/skills`) and the ancestor `.agents/skills` dirs are only added when the project is trusted (`dist/core/package-manager.js:2183-2195`, `:2209`). Its agent dir is fresh (`cliProfiles.ts:266`), `HOME=/root` (`cliProfiles.ts:264`). Image contents of `/root/.agents/skills` were **not** checked.

**Durable agent: loads NO skills.**
- Installed extensions: `apps/agents/src/session/SessionDO.ts:211-240` (`codingTools`, `fileTools`, `projectContext`, `permissions`, mode sections, `proposePlan`, `askUser`, t3 catalog, MCP, code mode / tool search). None is a skill loader. `projectContext` reads only `AGENTS.md` / `CLAUDE.md` (`apps/agents/src/extensions/project-context.ts:1-40`; installed at `SessionDO.ts:216`).
- `WorkspaceDO.skills()`, `prompts()`, `instructions()` return `[]` (`apps/agents/src/workspace/WorkspaceDO.ts:597-608`). No caller: `grep '\.skills('` in `apps/agents/src` finds only the definition; `SessionDO.ts:591` is a comment that names it.
- pi-durable 1.5.0 (`apps/agents/package.json:16`; installed copy at `/Users/ianpascoe/.cache/aube/virtual-store/v1/@earendil-works+pi-durable@1.5.0_…/node_modules/@earendil-works/pi-durable/dist`): no skill loader, no `<available_skills>`, no `/skill:` handling. The only `skill` hits in its `.js`/`.d.ts` are generic filesystem fixtures in `dist/testing/env-conformance.js:259-328`.
- Durable system prompt contents: **UNKNOWN** (not inspected beyond the grep above).

---

## 3. Where files live; can the Environment read a workspace's skills?

- **Workspace = source of truth, Container = synced copy.** Workspace DO holds a `@cloudflare/computer` SQLite VFS (`docs/adr/0008-…md:3`). Repo root inside the DO: `/workspace/repo` (`packages/workspace-client/src/index.ts:9`). The t3 path `/w/<workspaceId>` is the repo root (`docs/adr/0008-…md:3`). Worktrees `/w/.wt/<project>/<dir>` (`docs/adr/0008-…md`, refinement; `apps/environment/src/platform/routingFileSystem.ts:1-9`).
- **Reads never start the Container.** `docs/adr/0009-…md:7` ("File reads, writes and search go to the Workspace DO and never start the Container"). Git runs in the Container (`0009`, §Decision).
- **State directory** is DO SQLite (`docs/adr/0007-…md:3`). Not the repo.
- **Environment-side access, existing:**
  - `apps/environment/src/platform/routingFileSystem.ts` maps `/w/<id>/…` to the Workspace DO over RPC: `readFile` → op `read` (`:139`, `:255`); `readDirectory` → op `find` or `readdir` (`:233-240`).
  - `apps/environment/src/agents/workspaceClient.ts:21-31` (`locate(path)` returns `{id, inner, record, rpc}`); `workspaceRpc(id)` at `:14-18`.
  - `apps/environment/src/agents/rpc.ts:37-47` (`FsOp`: `stat | read | write | readdir | mkdir | remove | rename | realPath | find | grep`).
  - Example use: `apps/environment/src/host/workspacesCheck.ts:35-36`.
  - No skill-specific helper exists (`grep -i skill apps/environment/src` finds only the harness page and icon).
- **Can a Durable snapshot read `.agents/skills/*/SKILL.md`?** **Yes, mechanically.** The provider registry runs in the Environment (`apps/environment/src/t3/composition.ts` references it; ADR-0002 `docs/adr/0002-…md:3`). It can call `locate(cwd)` or use the Effect `FileSystem` at `/w/<id>/.agents/skills` and read each `SKILL.md` (`routingFileSystem.ts`). Cost: wakes the Workspace DO, not the Container (ADR-0009). Scan is keyed by cwd (`ProviderRegistry.ts:1045-1062`). Caveat: a worktree thread's cwd is under `/w/.wt/…`.
- **Durable agent's own file access:** `SessionDO.ts:601-611` (`#envAt`) builds a `ComputerExecutionEnv` over the Workspace DO's `fileOperation` (`WorkspaceDO.ts:584-592`), cwd `REPO_ROOT` by default (`SessionDO.ts:604`). `project-context.ts:20-40` reads `AGENTS.md` through it.

---

## 4. Harness panel: Skills placeholder and settings storage

- **Route:** `/_t3flare/harness` (`apps/environment/src/harness/panel.ts:23`; ADR-0026 §1, `docs/adr/0026-…md`).
- **Placeholder, exact:** section `#skills`, heading "Skills", empty state **"Skills aren't here yet"**, body **"Pi Durable's skills get their switches in this section once SPI-1001 lands."** (`apps/environment/src/harness/page.ts:270-272`). Nav item `navItem("skills", "Skills", "skills")` (`page.ts:337`); rendered at `page.ts:348`. Icon `pageIcons.ts:8`.
- **Status line:** `"Skills": "deferred (SPI-1001)"` (`apps/environment/src/harness/panel.ts:85-89`). Plan: `docs/steps/tools-plan.md:22`, `:70`, `:430`. Parity: `docs/steps/tools.md:201`.
- **Storage:** Environment DO KV. Settings at key `t3flare:harness:settings` (`apps/environment/src/harness/store.ts:13`, `load`/`save` at `:41-43`), default `EMPTY_HARNESS`. Audit `t3flare:harness:audit`, 1 000 kept (`store.ts:14`, `:17`, `:45-46`). Last-read marker `store.ts:58-59`.
- **Change path:** every change is validated against the registry, bumps the revision, and is audited (`panel.ts:12`). Revision shown at `page.ts:323`, `:341`.
- **Applied:** a Session records the settings it last took under `t3flare:harness` (`apps/agents/src/session/SessionDO.ts:126`); a turn's start waits a bounded time for the Environment's settings (`SessionDO.ts:132`); installed at construction (`:242`) and again on a later read (`:329`). Changes apply at the next turn (`GLOSSARY.md:169-172`; ADR-0026 §4).
- **Registry:** `packages/harness-registry` holds the extension list (code mode, offered tools, tool search, MCP). No skill entry (`grep -i skill packages/harness-registry/src` is empty). ADR-0026 §5 says the panel renders forms from registry entries.
- **Inconsistency:** `docs/steps/tools-plan.md:447` says "Skills (ADR-0026: the placeholder links SPI-1001)", but ADR-0026 contains no "skill" text (`grep -c -i skill docs/adr/0026-…md` = 0). The link is **UNKNOWN**.

---

## 5. cloudpid reference (vendored subset)

**What is vendored.** `vendor/cloudpid/{config,protocol,mcp}` at cloudpid `93ba45a` (`vendor/cloudpid/README.md:3-6`). **Not vendored:** cloudpid's ADR-0026 (Skills), `docs/architecture/*` (cited at `vendor/cloudpid/protocol/src/skills.ts:1-2`), and cloudpid's agent-side extensions and web UI. Those are **UNKNOWN**.

- **Model and storage.** Skills are per Environment, served read-only in every Workspace at `/workspace/.agents/skills/<name>` (`vendor/cloudpid/protocol/src/harness-tools/skill-words.ts:9`; `protocol/src/skills.ts:16-19`). A Skill's files are kept in the Registry (`protocol/src/skills.ts:51-65` `EnvironmentSkill`, `:83-88` `SkillChangeValue`). Limits: 1.5 MiB per file, 4 MiB per Skill, 8 MiB per set (`skill-words.ts:16-25`); 100 Skills per set (`harness-tools/environment-skills.ts:92`).
- **Sources.**
  - GitHub install, pinned to commit: `SkillSource {repo, path, ref, commit}` (`protocol/src/skills.ts:26-34`). Source forms `owner/repo`, `owner/repo@skill`, or a GitHub `tree/<ref>/<path>` URL; private repos via the GitHub App (`protocol/src/harness-tools/environment-skills.ts`, install description at `:94-~130`).
  - skills.sh directory: search, leaderboards, and repo listing (`protocol/src/registry.ts:936-937`, `:945-947`, `:968-1011`; types `protocol/src/skills.ts:246-268`).
  - Other sources (GitLab, etc.): the agent runs `npx skills add … --copy` in a Container and saves with `environment_skill_save`, which is a later stage ("S4b") (`environment-skills.ts` header comment, lines 1-9).
- **Scopes.** Environment (`id` = that Environment) or Global (`id = "*"`, `GLOBAL_ID`) (`environment-skills.ts:94-130` install; `:166` remove). Global steers every future Session and needs the owner's Approval (`environment-skills.ts` install description; `skill-words.ts:53-68`: `SKILL_APPROVAL`, `GLOBAL_SKILL_ASK`, `INSTALL_APPROVAL`). Approval card shows up to 10 Skills (`skill-words.ts:41`) and 16 000 characters each (`skill-words.ts:47`).
- **Agent changes.** Environment-scope installs, updates and removes apply at once and are recorded as Agent changes with files before/after, revertable on the Skills page (`environment-skills.ts` install and update descriptions). A modified Skill is refused unless `overwrite` (`environment-skills.ts`, `Overwrite` schema). Approvals: the Session call waits with no deadline; the endpoint answers `pending` with an `approval_id`, expiring in 7 days (`skill-words.ts` `GLOBAL_SKILL_ASK`).
- **Delivery to the agent.** The vendored code shows the file location and approvals, not how the model sees a skill. Model-side mechanism (system-prompt listing, or a tool): **UNKNOWN**. Vendored `Catalog` answers "Templates and Skills are those of the conversation's directory and the directories above it up to the Workspace root, nearest first; Skills include the ones the model is not offered (`disable-model-invocation`)" (`protocol/src/session.ts:1626-1628`). That implies model-side listing exists in cloudpid's agent, but the code is not vendored.
- **Composer.** `CatalogEntry` is "a Prompt template or a Skill the composer offers: `/name` or `/skill:name` and `$name`" (`protocol/src/session.ts:1616-1619`). `Catalog {commands, templates, skills, prompts, mcpServers}` (`protocol/src/session.ts:1632-1640`). Slash commands per conversation: `sessionCommandsFor` (`protocol/src/session.ts:1613`). How the composer expands the pick server-side: **UNKNOWN**.
- **MCP surface.** Same words for the MCP endpoint's management tools (`vendor/cloudpid/mcp/src/server/harness.ts:1-12`); `environment_skill_*` endpoint variants in `environment-skills.ts`.

---

## 6. pi coding agent (1.5.2) and pi-durable

**Installed sources.** pi CLI: `/Users/ianpascoe/.local/share/chezmoi/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.5.2_…/node_modules/@earendil-works/pi-coding-agent/dist` (same version the image pins, `apps/sandbox-image/src/clis.ts:13-16`). Docs: `/Users/ianpascoe/.local/share/mise/installs/pi/1.5.2/pi/docs/skills.md`.

- **Format.** A directory containing `SKILL.md`, Agent Skills spec. Frontmatter `name` (≤64 chars), `description` (≤1024; a skill without one is not loaded), `disable-model-invocation` (`docs/skills.md`, "Create a skill", "Write portable frontmatter").
- **Discovery.** Defaults: `<agentDir>/skills` (user) and `<cwd>/.pi/skills` (project) (`dist/core/resource-loader.js:772-778`; `dist/core/skills.js:354-362` with `includeDefaults`). Also `~/.agents/skills` and `.agents/skills` in the cwd and ancestors up to the repo root, both **only when the project is trusted** (`dist/core/package-manager.js:2182-2209`). Trust is off under `--no-approve` (`args.js:232`, `:335`).
- **System prompt.** At startup pi adds each skill's name, description and location to the system prompt as `<available_skills>` (`dist/core/skills.js:278-301`, `formatSkillsForPrompt`; wired in `dist/core/system-prompt.js:105`). Full instructions are loaded only when the model reads the SKILL.md (`docs/skills.md`, "Understand how skills load"). The read tool is chosen as `read`, `bash` or `indirect` (`system-prompt.js` skill-file tool selection).
- **`/skill:name` expansion.** `AgentSession._expandSkillCommand` (`dist/core/agent-session.js:1807-1830`): only when the text starts with `/skill:`; wraps the body as `<skill name location>` with "References are relative to <baseDir>", then appends the args. Called from prompt handling (`agent-session.js:1742-1745`). Skill commands are listed as `skill:<name>` (`agent-session.js:2853`; `interactive-mode.js:551`; `rpc-mode.js:582`).
- **Collisions:** first skill wins with a warning (`dist/core/skills.js:316-345`, `loadSkills` collision handling).

**pi-durable 1.5.0.** No skill support (see §2). It does not depend on the pi CLI's skill loader. Its shipped `dist` has no `available_skills` or `/skill:` handling.

**Implication for t3flare.** The Durable agent cannot load skills without a new extension. The pi CLI in the Container loads no repo skills under `--no-approve` (§2).

---

## UNKNOWN (checked, not determined)

1. Codex's own skill scan roots (checked: t3 code only maps `scope`; Codex source not in repo).
2. OpenCode's own skill roots (not in repo).
3. Whether Codex, OpenCode, Claude load repo skills **at runtime** after the back-to-stock refinement (only code and pre-refinement evidence).
4. Whether `/root/.agents/skills` exists in the image (pi's user-level skills under `HOME=/root`).
5. cloudpid's model-side skill delivery and composer expansion (agent code not vendored; ADR-0026 not vendored).
6. The Durable agent's full system prompt (pi-durable's prompt not read beyond grep).
7. Whether t3's pi extension (with the `$name` input hook, `mcpExtensionSource.ts:268-296`) is injected into t3flare's pi CLI. `cliProfiles.ts:290-296` injects "t3's own permission extension"; not confirmed that it is the same source with the skill hook.
8. Link between tools-plan "Skills (ADR-0026 …)" and ADR-0026 (ADR-0026 has no skill text).
