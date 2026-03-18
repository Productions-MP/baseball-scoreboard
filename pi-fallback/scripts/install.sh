#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FALLBACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${FALLBACK_DIR}/.." && pwd)"
SERVICE_TEMPLATE="${FALLBACK_DIR}/services/scoreboard-fallback.service"
SERVICE_TARGET="/etc/systemd/system/scoreboard-fallback.service"
ENV_FILE="${FALLBACK_DIR}/pi.env"
PI_USER="${SUDO_USER:-$USER}"

PRIMARY_URL="${1:-}"

if [ -z "${PRIMARY_URL}" ] && [ -f "${ENV_FILE}" ]; then
  PRIMARY_URL="$(grep '^PRIMARY_DISPLAY_URL=' "${ENV_FILE}" | cut -d'=' -f2- || true)"
fi

if [ -z "${PRIMARY_URL}" ]; then
  echo "Usage: ./install.sh https://your-site.netlify.app/display/"
  exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
  cp "${FALLBACK_DIR}/pi.env.example" "${ENV_FILE}"
fi

python3 -m venv "${FALLBACK_DIR}/.venv"
"${FALLBACK_DIR}/.venv/bin/pip" install --upgrade pip
"${FALLBACK_DIR}/.venv/bin/pip" install -r "${FALLBACK_DIR}/requirements.txt"

python3 - <<PY
from pathlib import Path

env_path = Path(r"${ENV_FILE}")
lines = env_path.read_text(encoding="utf-8").splitlines()
updates = {
    "PRIMARY_DISPLAY_URL": r"${PRIMARY_URL}",
    "FALLBACK_DISPLAY_URL": "http://127.0.0.1:5050/display",
    "FALLBACK_CONTROL_URL": "http://127.0.0.1:5050/control",
}

existing = {}
for line in lines:
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        existing[key] = value

existing.update(updates)

ordered_keys = [
    "PRIMARY_DISPLAY_URL",
    "FALLBACK_DISPLAY_URL",
    "FALLBACK_CONTROL_URL",
    "FALLBACK_HOST",
    "FALLBACK_PORT",
    "FALLBACK_CONTROL_KEY",
    "SCHOOL_NAME",
]

new_lines = []
for key in ordered_keys:
    if key in existing:
        new_lines.append(f"{key}={existing[key]}")

env_path.write_text("\\n".join(new_lines) + "\\n", encoding="utf-8")
PY

chmod +x "${FALLBACK_DIR}/scripts/"*.sh

python3 - <<PY
from pathlib import Path

template_path = Path(r"${SERVICE_TEMPLATE}")
target_path = Path("/tmp/scoreboard-fallback.service")
content = template_path.read_text(encoding="utf-8")
content = content.replace("__REPO_ROOT__", r"${REPO_ROOT}")
content = content.replace("__PI_USER__", r"${PI_USER}")
target_path.write_text(content, encoding="utf-8")
PY

sudo cp /tmp/scoreboard-fallback.service "${SERVICE_TARGET}"
sudo systemctl daemon-reload
sudo systemctl enable --now scoreboard-fallback.service

AUTOSTART_DIR="/home/${PI_USER}/.config/lxsession/LXDE-pi"
AUTOSTART_FILE="${AUTOSTART_DIR}/autostart"
mkdir -p "${AUTOSTART_DIR}"
touch "${AUTOSTART_FILE}"

if ! grep -Fq "${FALLBACK_DIR}/scripts/open-primary.sh" "${AUTOSTART_FILE}"; then
  printf '\n@bash %s/scripts/open-primary.sh\n' "${FALLBACK_DIR}" >> "${AUTOSTART_FILE}"
fi

DESKTOP_DIR="/home/${PI_USER}/Desktop"
mkdir -p "${DESKTOP_DIR}"

cat > "${DESKTOP_DIR}/Scoreboard Primary.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Scoreboard Primary
Exec=bash -lc '${FALLBACK_DIR}/scripts/open-primary.sh'
Terminal=false
EOF

cat > "${DESKTOP_DIR}/Scoreboard Fallback.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Scoreboard Fallback
Exec=bash -lc '${FALLBACK_DIR}/scripts/open-fallback.sh'
Terminal=false
EOF

chmod +x "${DESKTOP_DIR}/Scoreboard Primary.desktop" "${DESKTOP_DIR}/Scoreboard Fallback.desktop"

echo "Fallback server installed."
echo "Primary display URL: ${PRIMARY_URL}"
echo "Fallback display URL: http://127.0.0.1:5050/display"
echo "Fallback control URL on LAN: http://<pi-ip>:5050/control"
