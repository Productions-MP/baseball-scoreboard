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

"${SCRIPT_DIR}/kiosk.sh" "${DISPLAY_URL:-http://127.0.0.1:5050/display}"
