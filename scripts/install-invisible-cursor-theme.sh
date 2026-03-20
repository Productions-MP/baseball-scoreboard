#!/usr/bin/env bash
set -eu

APP_USER="${USER}"
APP_HOME="$(getent passwd "${APP_USER}" 2>/dev/null | cut -d: -f6)"
APP_HOME="${APP_HOME:-/home/${APP_USER}}"
THEME_ROOT="${APP_HOME}/.local/share/icons/scoreboard-invisible"
CURSOR_DIR="${THEME_ROOT}/cursors"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}

trap cleanup EXIT

if ! command -v xcursorgen >/dev/null 2>&1; then
  echo "Warning: xcursorgen was not found; skipping invisible cursor theme setup." >&2
  exit 0
fi

mkdir -p "${CURSOR_DIR}"

python3 - "${TMP_DIR}/blank.png" <<'PY'
from pathlib import Path
import struct
import sys
import zlib


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


output_path = Path(sys.argv[1])
width = 32
height = 32
scanline = b"\x00" + (b"\x00\x00\x00\x00" * width)
payload = scanline * height

png = b"".join(
    [
        b"\x89PNG\r\n\x1a\n",
        chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)),
        chunk(b"IDAT", zlib.compress(payload, level=9)),
        chunk(b"IEND", b""),
    ]
)

output_path.write_bytes(png)
PY

cat > "${TMP_DIR}/blank.cursor.in" <<'EOF'
32 0 0 blank.png 1
EOF

xcursorgen "${TMP_DIR}/blank.cursor.in" "${TMP_DIR}/left_ptr"
install -m 0644 "${TMP_DIR}/left_ptr" "${CURSOR_DIR}/left_ptr"

for cursor_name in \
  default \
  arrow \
  left_ptr \
  top_left_arrow \
  right_ptr \
  center_ptr \
  cross \
  crosshair \
  text \
  xterm \
  hand1 \
  hand2 \
  pointer \
  wait \
  watch \
  left_ptr_watch \
  move \
  fleur \
  grab \
  grabbing \
  all-scroll
do
  ln -sfn left_ptr "${CURSOR_DIR}/${cursor_name}"
done

cat > "${THEME_ROOT}/index.theme" <<'EOF'
[Icon Theme]
Name=scoreboard-invisible
Comment=Invisible cursor theme for the scoreboard kiosk
Inherits=default
EOF
