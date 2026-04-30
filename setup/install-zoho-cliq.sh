#!/usr/bin/env bash
# Setup helper: install-zoho-cliq — bundles the preflight + install commands
# from the /add-zoho-cliq skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials.
#
# Copies the Zoho Cliq adapter in from the `channels` branch; appends the
# self-registration import; builds. All steps are safe to re-run.
# No additional npm packages needed — uses Node's built-in fetch.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_ZOHO_CLIQ ==="

CHANNEL_FILES=(
  src/channels/zoho-cliq.ts
)

needs_install=false
for f in "${CHANNEL_FILES[@]}"; do
  [[ -f "$f" ]] || needs_install=true
done
grep -q "import './zoho-cliq.js';" src/channels/index.ts || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch origin channels

echo "STEP: copy-files"
for f in "${CHANNEL_FILES[@]}"; do
  git show "origin/channels:$f" > "$f"
done

echo "STEP: register-import"
if ! grep -q "import './zoho-cliq.js';" src/channels/index.ts; then
  printf "import './zoho-cliq.js';\n" >> src/channels/index.ts
fi

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
