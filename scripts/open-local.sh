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

"${SCRIPT_DIR}/kiosk.sh" "${SCOREBOARD_DISPLAY_URL:-http://127.0.0.1:5050/display}"
