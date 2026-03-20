#!/usr/bin/env bash
set -eu

APP_USER="${USER}"
APP_HOME="$(getent passwd "${APP_USER}" 2>/dev/null | cut -d: -f6)"
APP_HOME="${APP_HOME:-/home/${APP_USER}}"
THEME_ROOT="${APP_HOME}/.local/share/icons/scoreboard-invisible"
CURSOR_DIR="${THEME_ROOT}/cursors"
DEFAULT_THEME_DIR="${APP_HOME}/.icons/default"
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
24 0 0 blank.png 1
32 0 0 blank.png 1
48 0 0 blank.png 1
EOF

xcursorgen -p "${TMP_DIR}" "${TMP_DIR}/blank.cursor.in" "${TMP_DIR}/left_ptr"
install -m 0644 "${TMP_DIR}/left_ptr" "${CURSOR_DIR}/left_ptr"

for cursor_name in \
  00008160000006810000408080010102 \
  028006030e0e7ebffc7f7070c0600140 \
  03b6e0fcb3499374a867c041f52298f0 \
  08e8e1c95fe2fc01f976f1e063a24ccd \
  1081e37283d90000800003c07f3ef6bf \
  14fef782d02440884392942c11205230 \
  2870a09082c103050810ffdffffe0204 \
  3085a0e285430894940527032f8b26df \
  3ecb610c1bf2410f44200f48c40d3599 \
  4498f0e0c1937ffe01fd06f973665830 \
  5c6cd98b3f3ebcb1f9c7f1c204630408 \
  6407b0e94181790501fd1e167b474872 \
  640fb0e74195791501fd1ed57b41487f \
  9081237383d90e509aa00f00170e968f \
  9d800788f1b08800ae810202380a0822 \
  e29285e634086352946a0e7090d73106 \
  f41c0e382c94c0958e07017e42b00462 \
  X_cursor \
  alias \
  based_arrow_down \
  based_arrow_up \
  bottom_left_corner \
  bottom_right_corner \
  bottom_side \
  bottom_tee \
  copy \
  dnd-copy \
  dnd-link \
  dnd-move \
  dnd-none \
  default \
  arrow \
  left_ptr \
  left_side \
  left_tee \
  link \
  question_arrow \
  right_side \
  sb_h_double_arrow \
  sb_v_double_arrow \
  top_right_corner \
  top_side \
  top_tee \
  top_left_arrow \
  right_ptr \
  center_ptr \
  cross \
  crosshair \
  dot \
  dotbox \
  text \
  ibeam \
  vertical-text \
  xterm \
  hand1 \
  hand2 \
  pointer \
  progress \
  wait \
  watch \
  left_ptr_watch \
  move \
  fleur \
  grab \
  grabbing \
  all-scroll \
  zoom-in \
  zoom-out
do
  ln -sfn left_ptr "${CURSOR_DIR}/${cursor_name}"
done

cat > "${THEME_ROOT}/index.theme" <<'EOF'
[Icon Theme]
Name=scoreboard-invisible
Comment=Invisible cursor theme for the scoreboard kiosk
Inherits=default
EOF

mkdir -p "${DEFAULT_THEME_DIR}"
cat > "${DEFAULT_THEME_DIR}/index.theme" <<'EOF'
[Icon Theme]
Inherits=scoreboard-invisible
EOF
