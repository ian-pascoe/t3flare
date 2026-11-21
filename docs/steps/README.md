# Step reports

A step report says what was tried on a real Stage, what passed and what did not, for one step or one Linear issue
(the SPI-#### names are the Maintainer's Linear issue ids). [`docs/history.md`](../history.md) summarises what the
milestones delivered.

## The archive

The reports, plans and plan reviews written up to 2026-11-21 are not on `main`. They are at the tag
[`docs-archive-1`](https://github.com/spiritledsoftware/t3flare/tree/docs-archive-1/docs), together with the step 0
spike (`docs/spike/`), the early research notes, the scope audit and the milestone plan. A citation such as
`docs-archive-1:docs/steps/spi-1151.md` is that path at that tag:

```sh
git show docs-archive-1:docs/steps/spi-1151.md
```

## Where the evidence is

The raw evidence of the reports up to the open-source release (JSON from the stage harnesses, screenshots, logs, the
one-off scripts that made some of it) is at the tag
[`steps-evidence-1`](https://github.com/spiritledsoftware/t3flare/tree/steps-evidence-1/docs/steps). A path such as
`docs/steps/step-2a/m3-memory.json`, cited by an ADR, a doc or a code comment, is that path at the tag:

```sh
git show steps-evidence-1:docs/steps/step-2a/m3-memory.json
```

Files that code reads or runs moved into the code:

- the step-4a and step-4b probes: [`apps/environment/scripts/probes/`](../../apps/environment/scripts/probes/);
- SPI-1151's recorded CLI roots: [`apps/environment/test/fixtures/spi-1151/m0-roots.json`](../../apps/environment/test/fixtures/spi-1151/m0-roots.json);
- SPI-1172's vendor fixture generator: [`packages/models/test/fixtures/gen-vendor-fixtures.mjs`](../../packages/models/test/fixtures/gen-vendor-fixtures.mjs).

## New evidence

The stage harnesses (`apps/environment/scripts/*.ts`) still write their output under `docs/steps/<step>/`. Git ignores
everything here but the reports (`.gitignore`), so output stays on the machine that made it. A report quotes the values
that decide it, so it stands without the files. A CI run uploads its raw output as a workflow artifact.
