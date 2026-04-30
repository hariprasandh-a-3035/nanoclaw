#!/usr/bin/env bash
#
# Install the Zoho Cliq adapter, persist credentials to .env + data/env/env,
# and restart the service. Non-interactive — the operator-facing credential
# instructions and paste prompts live in setup/channels/zoho-cliq.ts (the
# clack UI driver). Credentials come in via env vars:
#   ZOHO_CLIQ_CLIENT_ID, ZOHO_CLIQ_CLIENT_SECRET,
#   ZOHO_CLIQ_REFRESH_TOKEN, ZOHO_CLIQ_API_URL, ZOHO_CLIQ_ACCOUNTS_URL,
#   ZOHO_CLIQ_CHAT_IDS
#
# Emits exactly one status block on stdout (ADD_ZOHO_CLIQ) at the end. All
# chatty progress messages go to stderr so setup:auto's raw-log capture
# sees the full story without cluttering the final block for the parser.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

CHANNELS_REMOTE=origin
CHANNELS_BRANCH="${CHANNELS_REMOTE}/channels"

emit_status() {
  local status=$1 error=${2:-}
  local already=${ADAPTER_ALREADY_INSTALLED:-false}
  echo "=== NANOCLAW SETUP: ADD_ZOHO_CLIQ ==="
  echo "STATUS: ${status}"
  echo "ADAPTER_ALREADY_INSTALLED: ${already}"
  echo "API_URL: ${ZOHO_CLIQ_API_URL:-}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

log() { echo "[add-zoho-cliq] $*" >&2; }

# --- Validate required env vars -------------------------------------------

if [ -z "${ZOHO_CLIQ_CLIENT_ID:-}" ]; then
  emit_status failed "ZOHO_CLIQ_CLIENT_ID env var not set"
  exit 1
fi

if [ -z "${ZOHO_CLIQ_CLIENT_SECRET:-}" ]; then
  emit_status failed "ZOHO_CLIQ_CLIENT_SECRET env var not set"
  exit 1
fi

if [ -z "${ZOHO_CLIQ_REFRESH_TOKEN:-}" ]; then
  emit_status failed "ZOHO_CLIQ_REFRESH_TOKEN env var not set"
  exit 1
fi

if [ -z "${ZOHO_CLIQ_API_URL:-}" ]; then
  emit_status failed "ZOHO_CLIQ_API_URL env var not set"
  exit 1
fi

if [ -z "${ZOHO_CLIQ_ACCOUNTS_URL:-}" ]; then
  emit_status failed "ZOHO_CLIQ_ACCOUNTS_URL env var not set"
  exit 1
fi

if [ -z "${ZOHO_CLIQ_CHAT_IDS:-}" ]; then
  emit_status failed "ZOHO_CLIQ_CHAT_IDS env var not set (comma-separated list of chat IDs to poll)"
  exit 1
fi

# --- Install adapter if needed --------------------------------------------

need_install() {
  [ ! -f src/channels/zoho-cliq.ts ] && return 0
  ! grep -q "^import './zoho-cliq.js';" src/channels/index.ts 2>/dev/null && return 0
  return 1
}

ADAPTER_ALREADY_INSTALLED=true
if need_install; then
  ADAPTER_ALREADY_INSTALLED=false
  log "Fetching channels branch…"
  git fetch "$CHANNELS_REMOTE" channels >&2 2>/dev/null || {
    emit_status failed "git fetch ${CHANNELS_REMOTE} channels failed"
    exit 1
  }

  log "Copying adapter files from ${CHANNELS_BRANCH}…"
  for f in \
    src/channels/zoho-cliq.ts \
    src/channels/zoho-cliq.test.ts \
    setup/channels/zoho-cliq.ts \
    setup/add-zoho-cliq.sh \
    setup/install-zoho-cliq.sh; do
    git show "${CHANNELS_BRANCH}:$f" > "$f"
  done

  # Append self-registration import if missing.
  if ! grep -q "^import './zoho-cliq.js';" src/channels/index.ts; then
    echo "import './zoho-cliq.js';" >> src/channels/index.ts
  fi

  log "Building…"
  pnpm run build >&2 2>/dev/null || {
    emit_status failed "pnpm run build failed"
    exit 1
  }
else
  log "Adapter files already installed — skipping install phase."
fi

# --- Persist credentials to .env ------------------------------------------

persist_env() {
  local key=$1 val=$2
  touch .env
  if grep -q "^${key}=" .env; then
    awk -v k="$key" -v v="$val" \
        '$0 ~ "^"k"=" {print k"="v; next} {print}' \
      .env > .env.tmp && mv .env.tmp .env
  else
    echo "${key}=${val}" >> .env
  fi
}

persist_env ZOHO_CLIQ_CLIENT_ID "$ZOHO_CLIQ_CLIENT_ID"
persist_env ZOHO_CLIQ_CLIENT_SECRET "$ZOHO_CLIQ_CLIENT_SECRET"
persist_env ZOHO_CLIQ_REFRESH_TOKEN "$ZOHO_CLIQ_REFRESH_TOKEN"
persist_env ZOHO_CLIQ_API_URL "$ZOHO_CLIQ_API_URL"
persist_env ZOHO_CLIQ_ACCOUNTS_URL "$ZOHO_CLIQ_ACCOUNTS_URL"
persist_env ZOHO_CLIQ_CHAT_IDS "$ZOHO_CLIQ_CHAT_IDS"

# Container reads from data/env/env (the host mounts it).
mkdir -p data/env
cp .env data/env/env

# --- Restart service so the adapter picks up the new credentials ----------

log "Restarting service so the new adapter picks up the credentials…"
case "$(uname -s)" in
  Darwin)
    launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" >&2 2>/dev/null || true
    ;;
  Linux)
    systemctl --user restart nanoclaw >&2 2>/dev/null \
      || sudo systemctl restart nanoclaw >&2 2>/dev/null \
      || true
    ;;
esac

# Give the Zoho Cliq adapter a moment to finish starting (token refresh).
sleep 5

emit_status success
