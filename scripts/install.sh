#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LEGACY_ROOT="${APP_ROOT}/pi-fallback"
LOCAL_SERVICE_TEMPLATE="${APP_ROOT}/services/scoreboard-local.service"
DISPLAY_SERVICE_TEMPLATE="${APP_ROOT}/services/scoreboard-display.service"
STREAMDECK_SERVICE_TEMPLATE="${APP_ROOT}/services/scoreboard-streamdeck.service"
WIFI_FAILOVER_SERVICE_TEMPLATE="${APP_ROOT}/services/scoreboard-wifi-failover.service"
WIFI_FAILOVER_TIMER_TEMPLATE="${APP_ROOT}/services/scoreboard-wifi-failover.timer"
PAM_TEMPLATE="${APP_ROOT}/services/scoreboard-display.pam"
WIFI_SWITCH_SCRIPT="${APP_ROOT}/scripts/switch-wifi-to-usb.sh"
SYSTEMD_DIR="/etc/systemd/system"
LOCAL_SERVICE_TARGET="${SYSTEMD_DIR}/scoreboard-local.service"
DISPLAY_SERVICE_TARGET="${SYSTEMD_DIR}/scoreboard-display.service"
STREAMDECK_SERVICE_TARGET="${SYSTEMD_DIR}/scoreboard-streamdeck.service"
WIFI_FAILOVER_SERVICE_TARGET="${SYSTEMD_DIR}/scoreboard-wifi-failover.service"
WIFI_FAILOVER_TIMER_TARGET="${SYSTEMD_DIR}/scoreboard-wifi-failover.timer"
PAM_TARGET="/etc/pam.d/scoreboard-display"
SUDOERS_TARGET="/etc/sudoers.d/scoreboard-local-system-actions"
ENV_FILE="${APP_ROOT}/.env"
LEGACY_ENV_FILE="${LEGACY_ROOT}/pi.env"
APP_USER="${SUDO_USER:-$USER}"
APP_GROUP="$(id -gn "${APP_USER}")"
APP_UID="$(id -u "${APP_USER}")"
APP_HOME="$(getent passwd "${APP_USER}" 2>/dev/null | cut -d: -f6)"
APP_HOME="${APP_HOME:-/home/${APP_USER}}"
TMP_DIR="$(mktemp -d)"
APT_UPDATED="0"

cleanup() {
  rm -rf "${TMP_DIR}"
}

trap cleanup EXIT

run_as_app_user() {
  if [ "$(id -un)" = "${APP_USER}" ]; then
    "$@"
    return
  fi

  sudo -u "${APP_USER}" "$@"
}

apt_update_once() {
  if [ "${APT_UPDATED}" = "1" ]; then
    return
  fi

  sudo apt-get update
  APT_UPDATED="1"
}

install_apt_packages() {
  apt_update_once
  sudo apt-get install -y "$@"
}

cleanup_desktop_autostart() {
  autostart_file="$1"

  if [ ! -f "${autostart_file}" ]; then
    return
  fi

  python3 - "${autostart_file}" <<'PY'
from pathlib import Path
import sys

autostart_path = Path(sys.argv[1])
lines = autostart_path.read_text(encoding="utf-8").splitlines()
remove_fragments = (
    "open-primary.sh",
    "open-fallback.sh",
    "open-local.sh",
)

filtered = [line for line in lines if not any(fragment in line for fragment in remove_fragments)]
autostart_path.write_text("\n".join(filtered) + ("\n" if filtered else ""), encoding="utf-8")
PY
}

render_template() {
  source_path="$1"
  target_path="$2"

  python3 - "${source_path}" "${target_path}" "${APP_ROOT}" "${APP_USER}" "${APP_GROUP}" "${APP_UID}" <<'PY'
from pathlib import Path
import sys

source_path = Path(sys.argv[1])
target_path = Path(sys.argv[2])
content = source_path.read_text(encoding="utf-8")
replacements = {
    "__APP_ROOT__": sys.argv[3],
    "__APP_USER__": sys.argv[4],
    "__APP_GROUP__": sys.argv[5],
    "__APP_UID__": sys.argv[6],
}

for old_value, new_value in replacements.items():
    content = content.replace(old_value, new_value)

target_path.write_text(content, encoding="utf-8")
PY
}

if [ ! -f "${ENV_FILE}" ]; then
  if [ -f "${LEGACY_ENV_FILE}" ]; then
    cp "${LEGACY_ENV_FILE}" "${ENV_FILE}"
  else
    cp "${APP_ROOT}/.env.example" "${ENV_FILE}"
  fi
fi

sudo chown "${APP_USER}:${APP_GROUP}" "${ENV_FILE}" >/dev/null 2>&1 || true

if [ -d "${LEGACY_ROOT}/runtime" ] && [ ! -d "${APP_ROOT}/runtime" ]; then
  mv "${LEGACY_ROOT}/runtime" "${APP_ROOT}/runtime"
fi

if command -v apt-get >/dev/null 2>&1; then
  install_apt_packages python3 python3-venv python3-pip python3-dev build-essential libhidapi-dev libusb-1.0-0-dev dbus-user-session cage curl wlrctl

  if ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
    if ! install_apt_packages chromium-browser; then
      install_apt_packages chromium
    fi
  fi
fi

sudo usermod -a -G video,render,input "${APP_USER}" >/dev/null 2>&1 || true

if [ -d "${APP_ROOT}/.venv" ]; then
  sudo chown -R "${APP_USER}:${APP_GROUP}" "${APP_ROOT}/.venv"
fi

if [ -d "${APP_ROOT}/runtime" ]; then
  sudo chown -R "${APP_USER}:${APP_GROUP}" "${APP_ROOT}/runtime"
fi

run_as_app_user python3 -m venv "${APP_ROOT}/.venv"
run_as_app_user "${APP_ROOT}/.venv/bin/python" -m pip install --upgrade pip
run_as_app_user "${APP_ROOT}/.venv/bin/python" -m pip install -r "${APP_ROOT}/requirements.txt"

run_as_app_user python3 - "${ENV_FILE}" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
lines = env_path.read_text(encoding="utf-8").splitlines()
existing = {}

for line in lines:
    if "=" not in line or line.lstrip().startswith("#"):
        continue

    key, value = line.split("=", 1)
    existing[key.strip()] = value.strip()

port = existing.get("SCOREBOARD_PORT", "5050") or "5050"
existing.update(
    {
        "SCOREBOARD_DISPLAY_URL": f"http://127.0.0.1:{port}/display",
        "SCOREBOARD_CONTROL_URL": f"http://127.0.0.1:{port}/control",
    }
)

ordered_keys = [
    "SCOREBOARD_DISPLAY_URL",
    "SCOREBOARD_CONTROL_URL",
    "SCOREBOARD_HOST",
    "SCOREBOARD_PORT",
    "SCOREBOARD_CONTROL_KEY",
    "SCHOOL_NAME",
    "SCOREBOARD_STATE_FILE",
    "SCOREBOARD_STREAMDECK_BRIGHTNESS",
    "SCOREBOARD_STREAMDECK_POLL_SECONDS",
    "SCOREBOARD_STREAMDECK_CONFIRM_SECONDS",
    "SCOREBOARD_WIFI_SSID",
    "SCOREBOARD_WIFI_PSK",
]

new_lines = []
for key in ordered_keys:
    if key in existing:
        new_lines.append(f"{key}={existing[key]}")

for key in sorted(existing):
    if key not in ordered_keys:
        new_lines.append(f"{key}={existing[key]}")

env_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
PY

chmod +x "${APP_ROOT}/scripts/"*.sh
"${APP_ROOT}/scripts/install-fonts.sh"

render_template "${LOCAL_SERVICE_TEMPLATE}" "${TMP_DIR}/scoreboard-local.service"
render_template "${DISPLAY_SERVICE_TEMPLATE}" "${TMP_DIR}/scoreboard-display.service"
render_template "${STREAMDECK_SERVICE_TEMPLATE}" "${TMP_DIR}/scoreboard-streamdeck.service"
render_template "${WIFI_FAILOVER_SERVICE_TEMPLATE}" "${TMP_DIR}/scoreboard-wifi-failover.service"
render_template "${WIFI_FAILOVER_TIMER_TEMPLATE}" "${TMP_DIR}/scoreboard-wifi-failover.timer"
render_template "${PAM_TEMPLATE}" "${TMP_DIR}/scoreboard-display.pam"

SYSTEMCTL_BIN="$(command -v systemctl)"
SHUTDOWN_BIN="$(command -v shutdown)"
SUDOERS_TEMP="${TMP_DIR}/scoreboard-local-system-actions.sudoers"
cat > "${SUDOERS_TEMP}" <<EOF
${APP_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_BIN} restart scoreboard-local.service scoreboard-display.service
${APP_USER} ALL=(root) NOPASSWD: ${SHUTDOWN_BIN} -r now
${APP_USER} ALL=(root) NOPASSWD: ${SHUTDOWN_BIN} now
EOF
if command -v visudo >/dev/null 2>&1; then
  sudo visudo -cf "${SUDOERS_TEMP}"
fi

sudo systemctl disable --now scoreboard-fallback.service >/dev/null 2>&1 || true
sudo rm -f "${SYSTEMD_DIR}/scoreboard-fallback.service"
sudo systemctl disable --now scoreboard-wifi-switchover.service >/dev/null 2>&1 || true
sudo rm -f "${SYSTEMD_DIR}/scoreboard-wifi-switchover.service"
sudo systemctl disable --now scoreboard-wifi-failover.timer >/dev/null 2>&1 || true
sudo rm -f "${SYSTEMD_DIR}/scoreboard-wifi-failover.service" "${SYSTEMD_DIR}/scoreboard-wifi-failover.timer"
sudo systemctl disable --now scoreboard-display.service >/dev/null 2>&1 || true
sudo systemctl disable --now scoreboard-streamdeck.service >/dev/null 2>&1 || true
sudo install -m 0644 "${TMP_DIR}/scoreboard-local.service" "${LOCAL_SERVICE_TARGET}"
sudo install -m 0644 "${TMP_DIR}/scoreboard-display.service" "${DISPLAY_SERVICE_TARGET}"
sudo install -m 0644 "${TMP_DIR}/scoreboard-streamdeck.service" "${STREAMDECK_SERVICE_TARGET}"
sudo install -m 0644 "${TMP_DIR}/scoreboard-wifi-failover.service" "${WIFI_FAILOVER_SERVICE_TARGET}"
sudo install -m 0644 "${TMP_DIR}/scoreboard-wifi-failover.timer" "${WIFI_FAILOVER_TIMER_TARGET}"
sudo install -m 0644 "${TMP_DIR}/scoreboard-display.pam" "${PAM_TARGET}"
sudo install -m 0440 "${SUDOERS_TEMP}" "${SUDOERS_TARGET}"
sudo systemctl daemon-reload
sudo systemctl enable --now scoreboard-local.service
sudo systemctl enable --now scoreboard-display.service
sudo systemctl enable --now scoreboard-streamdeck.service
sudo systemctl enable --now scoreboard-wifi-failover.timer
sudo systemctl start scoreboard-wifi-failover.service >/dev/null 2>&1 || true
sudo systemctl set-default graphical.target

LXDE_AUTOSTART_DIR="${APP_HOME}/.config/lxsession/LXDE-pi"
LXDE_AUTOSTART_FILE="${LXDE_AUTOSTART_DIR}/autostart"
LABWC_AUTOSTART_DIR="${APP_HOME}/.config/labwc"
LABWC_AUTOSTART_FILE="${LABWC_AUTOSTART_DIR}/autostart"
cleanup_desktop_autostart "${LXDE_AUTOSTART_FILE}"
cleanup_desktop_autostart "${LABWC_AUTOSTART_FILE}"

rm -f "${APP_HOME}/Desktop/Scoreboard Display.desktop" "${APP_HOME}/Desktop/Scoreboard Control.desktop"

if [ -x "${WIFI_SWITCH_SCRIPT}" ]; then
  if ! "${WIFI_SWITCH_SCRIPT}"; then
    echo "Warning: USB Wi-Fi switchover did not complete. wlan0 remains available as the fallback interface." >&2
  fi
fi

BOOT_CONFIG_NOTE=""

if [ -f /boot/firmware/config.txt ] && ! grep -q "^dtoverlay=vc4-kms-v3d" /boot/firmware/config.txt; then
  BOOT_CONFIG_NOTE="${BOOT_CONFIG_NOTE}
- Ensure /boot/firmware/config.txt contains dtoverlay=vc4-kms-v3d"
fi

if [ -f /boot/firmware/config.txt ] && ! grep -q "^disable_overscan=1" /boot/firmware/config.txt; then
  BOOT_CONFIG_NOTE="${BOOT_CONFIG_NOTE}
- Consider adding disable_overscan=1 to /boot/firmware/config.txt"
fi

if [ -f /boot/firmware/cmdline.txt ] && ! grep -q "consoleblank=0" /boot/firmware/cmdline.txt; then
  BOOT_CONFIG_NOTE="${BOOT_CONFIG_NOTE}
- Add consoleblank=0 to the single /boot/firmware/cmdline.txt line to keep tty1 from blanking"
fi

if [ -f /boot/firmware/cmdline.txt ] && ! grep -q "video=HDMI-A-1:" /boot/firmware/cmdline.txt; then
  BOOT_CONFIG_NOTE="${BOOT_CONFIG_NOTE}
- Add video=HDMI-A-1:D to /boot/firmware/cmdline.txt to force the Pi 4 kiosk to HDMI-0"
fi

echo "Local scoreboard server installed."
DISPLAY_URL="$(grep -m1 '^SCOREBOARD_DISPLAY_URL=' "${ENV_FILE}" | cut -d= -f2- || true)"
CONTROL_URL="$(grep -m1 '^SCOREBOARD_CONTROL_URL=' "${ENV_FILE}" | cut -d= -f2- || true)"
PORT_VALUE="$(grep -m1 '^SCOREBOARD_PORT=' "${ENV_FILE}" | cut -d= -f2- || true)"
DISPLAY_URL="${DISPLAY_URL:-http://127.0.0.1:5050/display}"
CONTROL_URL="${CONTROL_URL:-http://127.0.0.1:5050/control}"
PORT_VALUE="${PORT_VALUE:-5050}"

echo "Display URL on Pi: ${DISPLAY_URL}"
echo "Control URL on Pi: ${CONTROL_URL}"
echo "Control URL on LAN: http://<pi-ip>:${PORT_VALUE}/control"

if [ -n "${BOOT_CONFIG_NOTE}" ]; then
  echo
  echo "Manual Raspberry Pi boot configuration still recommended:"
  printf '%s\n' "${BOOT_CONFIG_NOTE}"
fi
