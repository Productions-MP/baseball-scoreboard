#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEGACY_ENV_FILE="${SCRIPT_DIR}/../pi.env"
ENV_FILE="${SCRIPT_DIR}/../.env"

if [ -f "${LEGACY_ENV_FILE}" ]; then
  # shellcheck source=/dev/null
  . "${LEGACY_ENV_FILE}"
fi

if [ -f "${ENV_FILE}" ]; then
  # shellcheck source=/dev/null
  . "${ENV_FILE}"
fi

TARGET_URL="${1:-${SCOREBOARD_DISPLAY_URL:-http://127.0.0.1:5050/display}}"

pkill -f chromium >/dev/null 2>&1 || true
sleep 1

chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --overscroll-history-navigation=0 \
  --check-for-update-interval=31536000 \
  --window-size=768,192 \
  --app="${TARGET_URL}" >/dev/null 2>&1 &
