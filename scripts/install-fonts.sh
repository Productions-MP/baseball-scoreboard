#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FONT_SOURCE_DIR="${APP_ROOT}/public/fonts"
PI_USER="${SUDO_USER:-$USER}"
PI_HOME="$(getent passwd "${PI_USER}" 2>/dev/null | cut -d: -f6)"
PI_HOME="${PI_HOME:-/home/${PI_USER}}"
FONT_TARGET_DIR="${PI_HOME}/.local/share/fonts/baseball-scoreboard"

if [ ! -d "${FONT_SOURCE_DIR}" ]; then
  exit 0
fi

shopt -s nullglob
installable_fonts=("${FONT_SOURCE_DIR}"/*.otf "${FONT_SOURCE_DIR}"/*.ttf)

if [ "${#installable_fonts[@]}" -eq 0 ]; then
  exit 0
fi

mkdir -p "${FONT_TARGET_DIR}"
cp -f "${installable_fonts[@]}" "${FONT_TARGET_DIR}/"
chown -R "${PI_USER}:${PI_USER}" "${PI_HOME}/.local/share/fonts"

if command -v fc-cache >/dev/null 2>&1; then
  sudo -u "${PI_USER}" fc-cache -f "${PI_HOME}/.local/share/fonts" >/dev/null 2>&1 || true
fi
