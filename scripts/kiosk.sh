#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEGACY_ENV_FILE="${SCRIPT_DIR}/../pi.env"
ENV_FILE="${SCRIPT_DIR}/../.env"

read_env_value() {
  key="$1"
  result=""

  for file_path in "${LEGACY_ENV_FILE}" "${ENV_FILE}"; do
    if [ ! -f "${file_path}" ]; then
      continue
    fi

    line="$(grep -m1 "^${key}=" "${file_path}" || true)"

    if [ -n "${line}" ]; then
      result="${line#*=}"
    fi
  done

  printf '%s' "${result}" | tr -d '\r'
}

DISPLAY_URL="$(read_env_value "SCOREBOARD_DISPLAY_URL")"
TARGET_URL="${1:-${DISPLAY_URL:-http://127.0.0.1:5050/display}}"

if command -v chromium-browser >/dev/null 2>&1; then
  CHROMIUM_BIN="chromium-browser"
elif command -v chromium >/dev/null 2>&1; then
  CHROMIUM_BIN="chromium"
else
  echo "Chromium was not found. Install chromium-browser or chromium to use kiosk mode." >&2
  exit 1
fi

pkill -f chromium >/dev/null 2>&1 || true
sleep 1

"${CHROMIUM_BIN}" \
  --kiosk \
  --noerrdialogs \
  --no-first-run \
  --disable-infobars \
  --overscroll-history-navigation=0 \
  --check-for-update-interval=31536000 \
  --window-size=768,192 \
  --app="${TARGET_URL}" >/dev/null 2>&1 &
