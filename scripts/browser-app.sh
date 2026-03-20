#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_DIR="${APP_ROOT}/runtime"
CHROMIUM_PROFILE_DIR="${RUNTIME_DIR}/chromium-profile"

if command -v chromium-browser >/dev/null 2>&1; then
  CHROMIUM_BIN="chromium-browser"
elif command -v chromium >/dev/null 2>&1; then
  CHROMIUM_BIN="chromium"
else
  echo "Chromium was not found. Install chromium-browser or chromium to open the scoreboard." >&2
  exit 1
fi

KIOSK_MODE="0"
DETACH_MODE="0"
TARGET_URL=""

for arg in "$@"; do
  case "${arg}" in
    --kiosk)
      KIOSK_MODE="1"
      ;;
    --detach)
      DETACH_MODE="1"
      ;;
    *)
      TARGET_URL="${arg}"
      ;;
  esac
done

if [ -z "${TARGET_URL}" ]; then
  echo "Usage: $(basename "$0") [--detach] [--kiosk] <url>" >&2
  exit 1
fi

mkdir -p "${CHROMIUM_PROFILE_DIR}"

CHROMIUM_ARGS=(
  --app="${TARGET_URL}"
  --noerrdialogs
  --no-first-run
  --disable-infobars
  --check-for-update-interval=31536000
  --password-store=basic
  --disable-session-crashed-bubble
  --disable-features=MediaRouter,Translate
  --disable-component-update
  --no-default-browser-check
  --user-data-dir="${CHROMIUM_PROFILE_DIR}"
)

if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  CHROMIUM_ARGS+=(
    --enable-features=UseOzonePlatform
    --ozone-platform=wayland
  )
fi

if [ "${KIOSK_MODE}" = "1" ]; then
  CHROMIUM_ARGS+=(
    --kiosk
  )
fi

if [ "${DETACH_MODE}" = "1" ]; then
  "${CHROMIUM_BIN}" "${CHROMIUM_ARGS[@]}" >/dev/null 2>&1 &
  exit 0
fi

exec "${CHROMIUM_BIN}" "${CHROMIUM_ARGS[@]}"
