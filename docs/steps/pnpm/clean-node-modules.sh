#!/usr/bin/env bash
# Removes the installed tree: the root node_modules and each workspace member's own node_modules, nothing deeper
# (t3code tracks node_modules fixtures under .repos/, which a recursive find would delete).
set -euo pipefail
cd "$(dirname "$0")/../../.."
rm -rf node_modules
for dir in apps/* packages/* vendor/cloudpid/* infra t3code/apps/* t3code/packages/* t3code/infra/* t3code/scripts t3code/evals t3code/oxlint-plugin-t3code t3code; do
  [ -d "$dir/node_modules" ] && rm -rf "$dir/node_modules"
done
git -C t3code status --porcelain | head -3
