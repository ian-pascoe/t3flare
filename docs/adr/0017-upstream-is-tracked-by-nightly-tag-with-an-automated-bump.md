# Upstream is tracked by nightly tag, with an automated bump

Stock clients and the laptop server update themselves while the cloud is pinned, so version skew is ongoing. The owner runs t3's nightly channel, so we track t3code's nightly tags (`v<version>-nightly.<yyyymmdd>.<run>`, several a day), not stable releases or `main`. A scheduled job pins the newest nightly tag in the submodule, re-applies Shadows and Patches, typechecks, and runs the acceptance test (a headless client pairs, creates a project and opens a thread) against a deployed stage. A bump that fails stays unpinned and is reported, and the cloud keeps the last good tag. A DO SQLite point-in-time bookmark is taken before t3's migrations run, because they only go forward. Version-coupled extras (the Claude ACP adapter that t3's registry expects) move in the same job.

## Considered Options

- **Stable release tags**: fewer bumps, but the owner's clients run nightly, so the cloud would lag the protocol his clients speak.
- **`main`**: untagged commits include ones nightly CI rejected.
