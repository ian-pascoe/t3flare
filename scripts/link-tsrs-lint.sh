#!/usr/bin/env bash
# Links tsrs's `tsrs-lint` as `node_modules/.bin/tsgolint`, where oxlint looks for its type-aware backend when
# OXLINT_TSGOLINT_PATH is unset, so a bare `oxlint --type-aware` and editors run tsrs-lint rather than the
# oxlint-tsgolint that oxlint and vite-plus bring. The repo's own lint scripts do not rely on this link: they set
# OXLINT_TSGOLINT_PATH themselves, which overrides an inherited value (ADR-0030). Run by `prepare`, after every
# `pnpm install`.
set -euo pipefail

cd "$(dirname "$0")/.."

link=node_modules/.bin/tsgolint
rm -f "$link"

if [ ! -x node_modules/.bin/tsrs-lint ]; then
  echo "link-tsrs-lint: no node_modules/.bin/tsrs-lint; a bare oxlint --type-aware will use another backend" >&2
  exit 0
fi

ln -s tsrs-lint "$link"
