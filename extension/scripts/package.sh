#!/usr/bin/env bash
# Test, lint and package the extension. Run from anywhere.
set -euo pipefail

EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$EXT_DIR"

IGNORE_FILES=(PLAN.md tests scripts package.json dist)

echo "==> node --test tests/"
node --test tests/

echo "==> web-ext lint"
npx --yes web-ext@8 lint --source-dir .

echo "==> web-ext build"
npx --yes web-ext@8 build --source-dir . --artifacts-dir dist --overwrite-dest \
  --ignore-files "${IGNORE_FILES[@]}"

echo "==> done: $EXT_DIR/dist"
