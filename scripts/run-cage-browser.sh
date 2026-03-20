#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_DIR="${APP_ROOT}/runtime"
CHROMIUM_PROFILE_DIR="${RUNTIME_DIR}/chromium-profile"
TARGET_URL="${1:-http://127.0.0.1:5050/display}"
CHROMIUM_PID=""

find_chromium_pid() {
  pgrep -n -f -- "--user-data-dir=${CHROMIUM_PROFILE_DIR}" || true
}

wait_for_chromium() {
  attempts="30"

  while [ "${attempts}" -gt 0 ]; do
    CHROMIUM_PID="$(find_chromium_pid)"

    if [ -n "${CHROMIUM_PID}" ]; then
      return 0
    fi

    attempts=$((attempts - 1))
    sleep 1
  done

  return 1
}

park_cursor_off_focus() {
  if ! command -v wlrctl >/dev/null 2>&1; then
    return 0
  fi

  # Cage does not currently provide a reliable upstream way to hide the
  # initial cursor in this kiosk flow, so park it hard in the bottom-right.
  # The large relative moves saturate at the output edge.
  sleep 2
  wlrctl pointer move 100000 100000 >/dev/null 2>&1 || true
  wlrctl pointer move 100000 100000 >/dev/null 2>&1 || true
}

"${SCRIPT_DIR}/browser-app.sh" --detach --kiosk "${TARGET_URL}"

if ! wait_for_chromium; then
  echo "Chromium did not start with profile ${CHROMIUM_PROFILE_DIR}." >&2
  exit 1
fi

park_cursor_off_focus

while kill -0 "${CHROMIUM_PID}" >/dev/null 2>&1; do
  sleep 2
done
