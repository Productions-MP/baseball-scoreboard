#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LEGACY_ENV_FILE="${APP_ROOT}/pi.env"
ENV_FILE="${APP_ROOT}/.env"
DEFAULT_PORT="5050"
WAIT_ATTEMPTS="90"
WAIT_DELAY_SECONDS="1"

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

wait_for_http() {
  url="$1"
  attempts="$2"

  while [ "${attempts}" -gt 0 ]; do
    if python3 - "${url}" <<'PY'
import sys
import urllib.request

url = sys.argv[1]

try:
    with urllib.request.urlopen(url, timeout=2) as response:
        raise SystemExit(0 if 200 <= response.status < 300 else 1)
except Exception:
    raise SystemExit(1)
PY
    then
      return 0
    fi

    attempts=$((attempts - 1))
    sleep "${WAIT_DELAY_SECONDS}"
  done

  return 1
}

disable_console_blanking() {
  tty_path="${1:-/dev/tty1}"

  if ! command -v setterm >/dev/null 2>&1; then
    return 0
  fi

  setterm --blank 0 --powersave off --powerdown 0 --cursor off <"${tty_path}" >"${tty_path}" 2>/dev/null || true
}

if ! command -v cage >/dev/null 2>&1; then
  echo "Cage was not found. Install the cage package before starting the kiosk session." >&2
  exit 1
fi

if ! command -v dbus-run-session >/dev/null 2>&1; then
  echo "dbus-run-session was not found. Install dbus-user-session before starting the kiosk session." >&2
  exit 1
fi

PORT="$(read_env_value "SCOREBOARD_PORT")"
PORT="${PORT:-${DEFAULT_PORT}}"
DISPLAY_URL="$(read_env_value "SCOREBOARD_DISPLAY_URL")"
TARGET_URL="${1:-${DISPLAY_URL:-http://127.0.0.1:${PORT}/display}}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"

mkdir -p "${APP_ROOT}/runtime"
disable_console_blanking "/dev/tty1"

if ! wait_for_http "${HEALTH_URL}" "${WAIT_ATTEMPTS}"; then
  echo "Scoreboard web app did not become ready at ${HEALTH_URL} before the kiosk timeout." >&2
  exit 1
fi

exec dbus-run-session -- cage -- "${SCRIPT_DIR}/run-cage-browser.sh" "${TARGET_URL}"
