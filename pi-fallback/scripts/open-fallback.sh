#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../pi.env"

if [ -f "${ENV_FILE}" ]; then
  # shellcheck source=/dev/null
  . "${ENV_FILE}"
fi

"${SCRIPT_DIR}/kiosk.sh" "${FALLBACK_DISPLAY_URL:-http://127.0.0.1:5050/display}"
