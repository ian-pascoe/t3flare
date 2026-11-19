## What and why

<!-- What this changes and why. Link the issue it closes, if any. -->

## How it was tested

<!-- `pnpm run check`, plus anything else: a throwaway Stage of your own Deployment, a stock client. Say what you could not test. -->

## Checklist

- [ ] `pnpm run check` passes.
- [ ] t3code is changed by Layer, then Shadow, then Patch; the submodule stays as pinned.
- [ ] `pnpm-workspace.yaml` and `pnpm-lock.yaml` changed only through `pnpm run relock`.
- [ ] New terms are in `GLOSSARY.md`; a hard-to-reverse decision has an ADR.
- [ ] No Deployment's values (emails, hostnames, account or zone ids, repository names) in the source.
