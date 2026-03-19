#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LEGACY_ROOT="${APP_ROOT}/pi-fallback"
SERVICE_TEMPLATE="${APP_ROOT}/services/scoreboard-local.service"
SERVICE_TARGET="/etc/systemd/system/scoreboard-local.service"
ENV_FILE="${APP_ROOT}/.env"
LEGACY_ENV_FILE="${LEGACY_ROOT}/pi.env"
PI_USER="${SUDO_USER:-$USER}"

if [ ! -f "${ENV_FILE}" ]; then
  if [ -f "${LEGACY_ENV_FILE}" ]; then
    cp "${LEGACY_ENV_FILE}" "${ENV_FILE}"
  else
    cp "${APP_ROOT}/.env.example" "${ENV_FILE}"
  fi
fi

if [ -d "${LEGACY_ROOT}/runtime" ] && [ ! -d "${APP_ROOT}/runtime" ]; then
  mv "${LEGACY_ROOT}/runtime" "${APP_ROOT}/runtime"
fi

python3 -m venv "${APP_ROOT}/.venv"
"${APP_ROOT}/.venv/bin/pip" install --upgrade pip
"${APP_ROOT}/.venv/bin/pip" install -r "${APP_ROOT}/requirements.txt"

python3 - <<PY
from pathlib import Path

env_path = Path(r"${ENV_FILE}")
lines = env_path.read_text(encoding="utf-8").splitlines()
updates = {
    "SCOREBOARD_DISPLAY_URL": "http://127.0.0.1:5050/display",
    "SCOREBOARD_CONTROL_URL": "http://127.0.0.1:5050/control",
}

existing = {}
for line in lines:
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        existing[key] = value

existing.update(updates)

ordered_keys = [
    "SCOREBOARD_DISPLAY_URL",
    "SCOREBOARD_CONTROL_URL",
    "SCOREBOARD_HOST",
    "SCOREBOARD_PORT",
    "SCOREBOARD_CONTROL_KEY",
    "SCHOOL_NAME",
]

new_lines = []
for key in ordered_keys:
    if key in existing:
        new_lines.append(f"{key}={existing[key]}")

env_path.write_text("\\n".join(new_lines) + "\\n", encoding="utf-8")
PY

chmod +x "${APP_ROOT}/scripts/"*.sh

python3 - <<PY
from pathlib import Path

template_path = Path(r"${SERVICE_TEMPLATE}")
target_path = Path("/tmp/scoreboard-local.service")
content = template_path.read_text(encoding="utf-8")
content = content.replace("__APP_ROOT__", r"${APP_ROOT}")
content = content.replace("__PI_USER__", r"${PI_USER}")
target_path.write_text(content, encoding="utf-8")
PY

sudo systemctl disable --now scoreboard-fallback.service >/dev/null 2>&1 || true
sudo rm -f /etc/systemd/system/scoreboard-fallback.service
sudo cp /tmp/scoreboard-local.service "${SERVICE_TARGET}"
sudo systemctl daemon-reload
sudo systemctl enable --now scoreboard-local.service

AUTOSTART_DIR="/home/${PI_USER}/.config/lxsession/LXDE-pi"
AUTOSTART_FILE="${AUTOSTART_DIR}/autostart"
mkdir -p "${AUTOSTART_DIR}"
touch "${AUTOSTART_FILE}"

python3 - <<PY
from pathlib import Path

autostart_path = Path(r"${AUTOSTART_FILE}")
lines = autostart_path.read_text(encoding="utf-8").splitlines() if autostart_path.exists() else []
legacy_entries = {
    "@bash ${LEGACY_ROOT}/scripts/open-primary.sh",
    "@bash ${LEGACY_ROOT}/scripts/open-fallback.sh",
    "@bash ${LEGACY_ROOT}/scripts/open-local.sh",
}
desired_entry = "@bash ${APP_ROOT}/scripts/open-local.sh"

filtered = [line for line in lines if line.strip() not in legacy_entries and line.strip() != desired_entry]
filtered.append(desired_entry)
autostart_path.write_text("\\n".join(filtered) + "\\n", encoding="utf-8")
PY

DESKTOP_DIR="/home/${PI_USER}/Desktop"
mkdir -p "${DESKTOP_DIR}"

cat > "${DESKTOP_DIR}/Scoreboard Display.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Scoreboard Display
Exec=bash -lc '${APP_ROOT}/scripts/open-local.sh'
Terminal=false
EOF

cat > "${DESKTOP_DIR}/Scoreboard Control.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Scoreboard Control
Exec=chromium-browser --app=http://127.0.0.1:5050/control
Terminal=false
EOF

chmod +x "${DESKTOP_DIR}/Scoreboard Display.desktop" "${DESKTOP_DIR}/Scoreboard Control.desktop"

echo "Local scoreboard server installed."
echo "Display URL on Pi: http://127.0.0.1:5050/display"
echo "Control URL on Pi: http://127.0.0.1:5050/control"
echo "Control URL on LAN: http://<pi-ip>:5050/control"
