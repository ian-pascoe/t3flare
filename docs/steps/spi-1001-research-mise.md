# SPI-1001 research: mise config layering, GitHub API use, tokens, trust, caches

Status: research complete for the five questions. Items marked **UNSETTLED** have an empirical test listed.

## Sources and versions

- Docs: `https://mise.jdx.dev/*` pages, plus the repo's `docs/` tree at `jdx/mise` commit `0d1396e8e6e07aa8b081d88cac67798c2c5c782d` (2026-11-13, `Cargo.toml` version `2026.11.8`).
- Source line numbers below are at that commit. Paths are relative to the repo root.
- Local binary used for empirical checks: `mise 2026.11.7 macos-arm64`. This is one patch behind the source checkout. Behaviour is assumed equal unless noted.
- GitHub rate limits: `https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api`.

## 1. Config hierarchy and merge semantics

**Precedence (lowest to highest):** system, global, project directories root-to-cwd, then global override files.

- Doc: <https://mise.jdx.dev/configuration.html#configuration-hierarchy>: "mise loads config in this order, and a later file overrides an earlier one: 1. System config in `/etc/mise`. 2. Global config in `~/.config/mise`. 3. Config files in every directory from the filesystem root down to the current directory... 4. Global override files (`config.override.toml`), which beat everything above."
- Code: `src/config/mod.rs:3158-3161`. The list is highest-first. Override files are spliced in front, then `global_config_files()` and `system_config_files()` are appended, so system is last (lowest).

**Per-section merge** (doc table, <https://mise.jdx.dev/configuration.html#merge-behavior-by-section>):

- `[tools]`: "Per tool. The nearest file's entry replaces that tool's whole entry, including its options. Other tools are inherited."
  - Code: `src/toolset/tool_request_set.rs:232-233` walks `config_files.values().rev()` (lowest first) and calls `merge(trs, cf)`. `merge()` at `:384-390` keeps every key from the accumulator that the newer file does not define. Keys are backend args, so `git` from system and `node` from global both survive. A same-key entry in a higher file replaces the lower one whole.
- `[env]`: "Per variable; the nearest file wins." Precedence list at <https://mise.jdx.dev/environments/#precedence>: "Any project config wins over the global config".
- `[settings]`: "Per setting." Precedence (<https://mise.jdx.dev/configuration/settings.html#which-value-wins>): "1. A command-line flag... 2. The setting's environment variable... 3. `[settings]` in project config... 4. `[settings]` in the global config... 5. `[settings]` in the system config... 6. The default". Project `[settings]` is ignored unless the file is trusted (see §4).
- `[tool_config]`: not merged; applies only within the same config root.

**Replacing files:**

- "`global_config_file` (`MISE_GLOBAL_CONFIG_FILE`) replaces all of these files with one file. It also turns off the override files." Source: `src/config/mod.rs` `global_config_files()` returns only that path when set (`:3728-3730`).
- "`system_config_file` (`MISE_SYSTEM_CONFIG_FILE`) replaces them with a single file." Separate from global; setting one does not disable the other.
- Gotcha from the doc: "It does not hide `~/.config/mise/config.toml` from projects under your home directory, which still load it as a project config; add ... to `ignored_config_paths`." (<https://mise.jdx.dev/configuration.html#global-config>). **UNSETTLED** for the owner's layout: see test T1.

**Empirical check (local 2026.11.7, `MISE_OFFLINE=1`, isolated state/data dirs):**

- System `{git, gh, node=18.0.0}`, global `{node=22.11.0, python=3.12}`, project `{node=20.1.0}`.
- `mise config ls` listed all three files in the expected order.
- `mise ls --json`: `gh` came from system, `python` from global, `node` from project, so the per-tool rule holds across all three.
- Removing the project file: `node` resolved to `22.11.0` from global, not 18.0.0 from system.
- `settings jobs`: global `7` beat system `2`.

## 2. Which backends call the GitHub API

Key fact: mise's default path for GitHub *metadata* is **mise-versions.jdx.dev**, not api.github.com. api.github.com is a fallback.

- Doc: <https://mise.jdx.dev/dev-tools/github-tokens.html>: "mise reads public GitHub release metadata through mise-versions, so most installs need no token." and "mise also calls the GitHub API directly when mise-versions fails to answer (a timeout, a lost connection, or a `429` or `5xx` response), or when `use_versions_host` is `false`."
- Setting (`settings.toml:4934-4965`, <https://mise.jdx.dev/configuration/settings.html#use_versions_host>): "Get version lists, public GitHub release metadata and attestations from mise-versions before upstream APIs." Also: "When the host errors (...), mise asks `api.github.com` for the same data instead, with your GitHub token if one is set." and "Anything the host answers is trusted, including a `404`..."
- Private repos, GitHub Enterprise, custom API URLs, and `use_versions_host = false` go direct to GitHub (same setting text).

**Version resolution flow (code):**

- Exact pins (two or more dots, or `backend.is_exact_version`) first try `backend.resolve_exact_version`: `src/toolset/tool_version.rs:1208-1213`. If that returns `None`, mise falls through to the full list (`:1214-1228`).
- Backends that implement `resolve_exact_version` (`grep` in `src/`): `github`, `cargo`, `npm`, `gem`, `go`, `pipx`, `dotnet`, core `rust`. **Core `node` does not** (`src/plugins/core/node.rs` has no override).
- Generic list path: `src/backend/mod.rs:3559-3607`. For versions-host-eligible tools (core plugins and registry tools, except `java` and `python`; `src/versions_host.rs:21-32`, `mod.rs:6491`), mise asks the versions host first. The backend's own listing runs only if that fails (`mod.rs:3615-3660`).
- `github` backend exact resolve: `src/backend/github.rs:1016-1060` calls `github::get_release_for_url_with_versions_host`, which is host-first.

**Per backend:**

| Backend / tool | Exact pin `X.Y.Z` | Fuzzy (`22`, `latest`) | Download |
|---|---|---|---|
| **core `node`** | Version lookup via `resolve_from_versions_index` / mise-versions list (`tool_version.rs:1217-1228`); fallback `nodejs.org/dist/index.json` (`src/plugins/core/node.rs:662-666`). **No GitHub.** | Same list; `latest` is resolved from that list. **No GitHub.** | `nodejs.org/dist/vX/node-vX-*.tar.gz`, checked against `SHASUMS256.txt` (`node.rs` ~958-976). **No GitHub.** |
| **github `owner/repo`** | `resolve_exact_version` → mise-versions release lookup (`github.rs:1016-1060`). No API call unless host errors. | Release list via `list_releases_including_prereleases_from_url` (`crates/mise-util/src/github.rs:277-289`), host-first. | One asset, browser URL: `asset_download_url` (`src/backend/github.rs:406-419`) → `pick_reachable_asset_url` (`crates/mise-util/src/github.rs:1878-1903`): a **HEAD probe to the github.com browser URL**; API URL only if the probe errors or returns `text/html` (auth page). |
| **aqua** (registry tools) | No `resolve_exact_version`; generic list path (`src/backend/aqua.rs:333`, `:350`) → host-first GitHub release list. | Same. | Browser URL from the bundled aqua registry, same `release_file_url` rules. |
| **ubi** | Deprecated: "Since 2026.4.0, mise prints a deprecation warning... removed in mise 2027.1.0" (<https://mise.jdx.dev/dev-tools/backends/ubi.html>). Not analysed further. | — | — |

**Answer to the question:**

- With exact pins on `node`, the install makes no GitHub request. Expect requests to mise-versions and nodejs.org only.
- With exact pins on a github or aqua tool, expect one host-first metadata request, and direct api.github.com only if the host fails.
- Fuzzy and `latest` behave the same way: they need the list, which is host-first.
- Download is github.com (browser URL) with a HEAD probe, not the API, for public repos.

**UNSETTLED: the actual request count per install.** Test T2 below.

**Offline switches:**

- `MISE_OFFLINE` / `offline`: "Block every HTTP request, so mise uses only installed tools and cached data." (<https://mise.jdx.dev/configuration/settings.html#offline>)
- `MISE_PREFER_OFFLINE` / `prefer_offline`: "Use cached version lists instead of fetching new ones... The versions host is skipped." (`settings.toml:3004-3014`)

## 3. Tokens and rate limits

**Read variables** (`crates/mise-util/src/github.rs:2197`, `GITHUB_TOKEN_ENV_VARS = ["MISE_GITHUB_TOKEN", "GITHUB_API_TOKEN", "GITHUB_TOKEN"]`; `crates/mise-util/src/env.rs:666`):

- `MISE_GITHUB_TOKEN`, `GITHUB_API_TOKEN`, `GITHUB_TOKEN`, in that order. Not `GH_TOKEN`: doc says "mise does not read `GH_TOKEN` itself, although a `gh auth token` credential command can." Confirmed by grep: `GH_TOKEN` is not read by any `src/` or `crates/` env lookup.
- `MISE_GITHUB_ENTERPRISE_TOKEN` applies only to non-github.com hosts.

**Full precedence** (doc table, <https://mise.jdx.dev/dev-tools/github-tokens.html#token-priority>; code `crates/mise-util/src/github.rs:2225-2335`, `resolve_token_inner`):

1. `MISE_GITHUB_ENTERPRISE_TOKEN` (non-github.com only)
2. `MISE_GITHUB_TOKEN`, then `GITHUB_API_TOKEN`, then `GITHUB_TOKEN`
3. `github.credential_command`
4. Native OAuth device-flow token
5. `github_tokens.toml` (per host, in `~/.config/mise` or `MISE_CONFIG_DIR`)
6. **gh CLI `hosts.yml`** (`github.gh_cli_tokens`, default `true`, `settings.toml:1188-1190`)
7. `git credential fill` (only if `github.use_git_credentials`)

"A wrong or expired token from a higher source hides a working one further down, because mise stops at the first token it finds."

**Gotcha for the container:** step 6 means that if the base image's `gh` is logged in (`~/.config/gh/hosts.yml`), mise sends that token to api.github.com. Test T4.

**Empty values:** the code path for mise's own HTTP calls uses `scoped_var`, which drops empty strings (`crates/mise-util/src/env.rs:1428-1435`). So `MISE_GITHUB_TOKEN=` with `GITHUB_TOKEN=x` yields `x`. **Verified locally** (`mise token github` printed `source: GITHUB_TOKEN`).

**Discrepancy (code only):** the static `GITHUB_TOKEN` used to pass a token to subprocesses (cargo, ubi, vfox) is built with `get_token()` (`crates/mise-util/src/env.rs:666`, `:806-810`), which keeps the first *set* variable and then filters blanks. An empty `MISE_GITHUB_TOKEN` therefore blocks `GITHUB_TOKEN` there. The test at `env.rs:1826-1834` asserts this. **UNSETTLED** for subprocess paths: test T5.

**Rate limits:**

- Unauthenticated: "The primary rate limit for unauthenticated requests is 60 requests per hour." Authenticated personal token: 5,000 per hour. (GitHub docs, above.)
- mise avoids this on the normal path by using mise-versions. Direct api.github.com traffic (and so the 60/hour budget) happens on host error, `use_versions_host = false`, private or Enterprise repos, custom `api_url`, and paranoid-mode attestation checks (`settings.toml` `use_versions_host` docs).

**No-API options:**

- There is no dedicated "no GitHub API" mode. The closest controls:
  - `MISE_USE_VERSIONS_HOST` (`settings.toml:5006`, default `true`) keeps host-first behaviour. Set `false` to go direct, which makes API calls. Not a no-API mode.
  - `MISE_OFFLINE=1` blocks all HTTP (install needs pre-installed tools).
  - `MISE_PREFER_OFFLINE=1` uses cached lists, skips the versions host, and allows one network fetch when nothing is cached.
  - `url_replacements` can reroute api.github.com (`settings.toml` `url_replacements` docs, <https://mise.jdx.dev/url-replacements.html>). Caution: rerouting api.github.com also stops mise using mise-versions for that metadata.
  - Lockfile `mise.lock` pins checksums; with `locked` mode, only pinned downloads are reused (`settings.toml` `download_cache` docs).
- Aqua registry: "Each mise release bundles a snapshot of the aqua registry and uses it by default" (<https://mise.jdx.dev/dev-tools/backends/aqua.html#bundled-registry>). The bundled snapshot covers **registry metadata only**, not version lists or release assets, which still need the host or GitHub.
- Core `node` is the only path tested here that touches neither the versions host for downloads nor GitHub at all.

## 4. Trust

**Global and system files: no trust needed.**

- `src/config/mod.rs:3511-3515`: `is_global_config()` returns true for global files, override files, and system files.
- `src/config/config_file/mod.rs:945-948`: `if config::is_global_config(path) { add_trusted(...); return true; }`. This check runs before the content-bound (paranoid) checks, so global and system files are trusted even in paranoid mode.
- Doc: "Global config is trusted without a record, so writing it decides nothing about a project" (`config_file/mod.rs:1263` comment).

**Project `mise.toml`:** needs trust only if it contains anything beyond the safe set. Doc (<https://mise.jdx.dev/security.html#what-needs-trust>): a file "loads without trust when it has no template syntax... and contains only: `min_version`; `[tools]` entries whose values are version strings or arrays of them... ; `[tasks]`, as long as no task lists `secrets`." "Anything else needs trust, including tool option tables, `[env]`, `[hooks]`, `[settings]`, ..." and "mise ignores the `[settings]` of a config that is not trusted."

**Implicit trust:** `mise run`, `mise install`, `mise exec`, and task shorthand trust the active config automatically outside CI (<https://mise.jdx.dev/security.html#implicit-trust>). `mise trust --show` shows `untrusted` even for files that need no trust. Local confirmation: `mise trust --show` printed `untrusted` for a plain `[tools]` project file.

**Implication for the owner's setup:** a repo `mise.toml` with only `[tools]` and no `[env]`/`[settings]` loads untrusted. Anything more needs `mise trust` or an implicit-trust command.

## 5. Install location and caching

**Directories** (<https://mise.jdx.dev/directories.html>):

- Installs: `~/.local/share/mise/installs/<tool>/<version>` (Linux), overridden by `MISE_DATA_DIR` (or `XDG_DATA_HOME/mise`), or `MISE_INSTALLS_DIR` for installs alone. Source: `crates/mise-util/src/dirs.rs:11-19`.
- Doc: "Installed tools depend on the OS, architecture, config, and native libraries of the machine that installed them. Copying this directory between unrelated machines is not a supported way to install tools."
- Doc: "Set these variables in the environment that starts mise... Do not set them in `[env]`."
- Cache: `~/.cache/mise` (`MISE_CACHE_DIR`). Holds rebuildable data such as version lists. `mise cache clear` does not uninstall tools as long as cache and data directories are separate.
- State: `~/.local/state/mise` holds trust decisions and the tracked config paths. Lose it and trust prompts return.

**Persistence:** installs persist only if `MISE_DATA_DIR` (or `MISE_INSTALLS_DIR`) persists across container runs. Anything in an ephemeral container's writable layer is lost on recreate. Doc (<https://mise.jdx.dev/directories.html#local-share-mise-downloads>): "To avoid reinstalling tools in CI, cache `installs/`, together with the install store when it is a separate directory."

**Download cache:**

- `download_cache` (default `true`, `settings.toml:700-702`): "mise keeps finished downloads in `$MISE_CACHE_DIR/downloads-cas`, named by their hash." Code: `crates/mise-util/src/http/cas.rs:89`.
- Reused when the server returns 304 for `ETag`/`Last-Modified`, or when a checksum is pinned in options or `mise.lock`.
- In-flight downloads: `$MISE_DATA_DIR/downloads` (`MISE_DOWNLOADS_DIR`), deleted afterwards.
- Version lists: cached under `MISE_CACHE_DIR`, refreshed after `fetch_remote_versions_cache` (default 1 hour) for `outdated`, `upgrade`, `ls-remote`, `lock`, `latest`. Install-time lists keep about 23h by default (<https://mise.jdx.dev/cache-behavior.html#version-list-refresh>).

**Container implication:** the cache (`downloads-cas`, version lists) is in `MISE_CACHE_DIR`, so caching installs without the cache means re-downloads. The `downloads-cas` directory and `installs/` should be persisted together (or both baked into the image).

## Open items (UNSETTLED) with the test that settles each

- **T1: global file under `$HOME`.** Doc says a `~/.config/mise/config.toml` loads twice when a project is under `$HOME`. Test: in the image, `cd ~/src/<repo> && mise config ls`. Expect the global file listed once.
- **T2: real GitHub API calls per install.** Test: set `GITHUB_TOKEN` and `MISE_GITHUB_TOKEN` unset, run `mise install node@22.11.0` and `mise install github:<owner>/<repo>@<exact>` with an HTTP proxy or `mitmdump` logging hosts. Count `api.github.com` requests, and repeat with `MISE_USE_VERSIONS_HOST=false` for comparison.
- **T3: what `git` and `gh` backends the base image uses.** `git` is **not** a mise registry name here: `mise registry git` returns "tool not found in registry: git", and `mise ls --json` silently omitted a bare `git` key in the local test. Test: `mise config ls` and `mise install --dry-run` (or `mise install`) in the image. Expect the owner's own config to set a backend prefix (`aqua:`, `github:`, or `core:`) for `git`.
- **T4: gh token leakage.** Test: in the image, with `gh` logged in, `mise token github` should report `source: GhCli`. If so, mise's api.github.com requests carry that token.
- **T5: empty token and subprocesses.** Code (`env.rs:666` vs `:1428`) says an empty `MISE_GITHUB_TOKEN` blocks `GITHUB_TOKEN` for cargo/ubi/vfox subprocesses but not for mise's own calls. Test: `MISE_GITHUB_TOKEN= GITHUB_TOKEN=x mise token github` (already verified: `GITHUB_TOKEN` used). The subprocess case needs a `cargo:` or `ubi:` install with a logging proxy.
- **T6: version drift.** Local binary `2026.11.7`, source `2026.11.8`. Test: `mise --version` in the image after pinning the owner's mise version. Re-check the `resolve_exact_version` and `versions_host` paths if behaviour differs.
- **T7: rate-limit budget per install.** Test: `curl -sI -H "Authorization:" https://api.github.com/rate_limit` before and after `mise install` with `MISE_USE_VERSIONS_HOST=false`; read `x-ratelimit-remaining`. Repeat with the default setting; expect no change.

## Summary of settled facts

- Hierarchy: system (lowest) < global < project dirs < global override files. `[tools]` merges per tool key (nearest whole entry wins), `[env]` per variable, `[settings]` per setting. Verified locally.
- Core `node` pins/fuzzy versions: no GitHub API. github/aqua tools: host-first metadata, API only on host failure; downloads from github.com browser URL.
- Tokens: `MISE_GITHUB_TOKEN` > `GITHUB_API_TOKEN` > `GITHUB_TOKEN`, then credential command, OAuth, token files, **gh `hosts.yml`**, git credentials. `GH_TOKEN` is not read. Unauthenticated limit: 60/hour.
- Trust: global and system files need none (even paranoid); project files need trust only beyond the safe `[tools]`/`[tasks]` subset.
- Persistence: `MISE_DATA_DIR` (installs) and `MISE_CACHE_DIR/downloads-cas` (downloads); keep them together across container runs.
