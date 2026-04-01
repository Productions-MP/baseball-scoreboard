#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${APP_ROOT}/.env"
USB_IFACE="${SCOREBOARD_WIFI_USB_IFACE:-wlan1}"
FALLBACK_IFACE="${SCOREBOARD_WIFI_FALLBACK_IFACE:-wlan0}"
USB_ADAPTER_ID="${SCOREBOARD_WIFI_USB_ADAPTER_ID:-0bda:c811}"
USB_METRIC="${SCOREBOARD_WIFI_USB_METRIC:-150}"
FALLBACK_METRIC="${SCOREBOARD_WIFI_FALLBACK_METRIC:-350}"
USB_DRIVER_PATTERN="${SCOREBOARD_WIFI_USB_DRIVER_PATTERN:-8821cu|8821c|rtl8821cu}"
WIFI_COUNTRY="${SCOREBOARD_WIFI_COUNTRY:-US}"
DISABLE_FALLBACK_ON_SUCCESS="${SCOREBOARD_WIFI_DISABLE_WLAN0:-1}"
SCOREBOARD_WIFI_SSID="${SCOREBOARD_WIFI_SSID:-}"
SCOREBOARD_WIFI_PSK="${SCOREBOARD_WIFI_PSK:-}"

log() {
  echo "[wifi-switchover] $*"
}

warn() {
  echo "[wifi-switchover] $*" >&2
}

load_env_overrides() {
  if [ ! -f "${ENV_FILE}" ]; then
    return
  fi

  eval "$(
    python3 - "${ENV_FILE}" <<'PY'
from pathlib import Path
import shlex
import sys

env_path = Path(sys.argv[1])
keys = [
    "SCOREBOARD_WIFI_SSID",
    "SCOREBOARD_WIFI_PSK",
    "SCOREBOARD_WIFI_COUNTRY",
    "SCOREBOARD_WIFI_DISABLE_WLAN0",
    "SCOREBOARD_WIFI_USB_IFACE",
    "SCOREBOARD_WIFI_FALLBACK_IFACE",
    "SCOREBOARD_WIFI_USB_METRIC",
    "SCOREBOARD_WIFI_FALLBACK_METRIC",
]
values = {key: "" for key in keys}

for raw_line in env_path.read_text(encoding="utf-8").splitlines():
    stripped = raw_line.strip()
    if not stripped or stripped.startswith("#") or "=" not in raw_line:
        continue

    key, value = raw_line.split("=", 1)
    key = key.strip()
    if key in values:
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value

for key in keys:
    print(f"{key}={shlex.quote(values[key])}")
PY
  )"
}

have_iface() {
  [ -d "/sys/class/net/$1" ]
}

adapter_present() {
  if have_iface "${USB_IFACE}"; then
    return 0
  fi

  if command -v lsusb >/dev/null 2>&1 && lsusb | tr '[:upper:]' '[:lower:]' | grep -q "${USB_ADAPTER_ID}"; then
    return 0
  fi

  if [ -L "/sys/class/net/${USB_IFACE}/device/driver" ] && readlink "/sys/class/net/${USB_IFACE}/device/driver" | grep -qi "usb"; then
    return 0
  fi

  return 1
}

driver_is_loaded() {
  command -v lsmod >/dev/null 2>&1 && lsmod | grep -Eq "${USB_DRIVER_PATTERN}"
}

bring_iface_up() {
  sudo ip link set "$1" up
}

default_route_uses_iface() {
  ip route show default 2>/dev/null | grep -q " dev $1"
}

wait_for_default_route() {
  iface="$1"
  attempts="${2:-15}"

  while [ "${attempts}" -gt 0 ]; do
    if default_route_uses_iface "${iface}"; then
      return 0
    fi

    sleep 1
    attempts=$((attempts - 1))
  done

  return 1
}

networkmanager_available() {
  command -v nmcli >/dev/null 2>&1 && nmcli general status >/dev/null 2>&1
}

write_dhcpcd_metrics() {
  if [ ! -f /etc/dhcpcd.conf ]; then
    return
  fi

  tmp_file="$(mktemp)"
  python3 - "/etc/dhcpcd.conf" "${tmp_file}" "${USB_IFACE}" "${USB_METRIC}" "${FALLBACK_IFACE}" "${FALLBACK_METRIC}" <<'PY'
from pathlib import Path
import sys

source_path = Path(sys.argv[1])
target_path = Path(sys.argv[2])
usb_iface = sys.argv[3]
usb_metric = sys.argv[4]
fallback_iface = sys.argv[5]
fallback_metric = sys.argv[6]
start_marker = "# BEGIN scoreboard-wifi-metrics"
end_marker = "# END scoreboard-wifi-metrics"

content = source_path.read_text(encoding="utf-8")
block = "\n".join(
    [
        start_marker,
        f"interface {usb_iface}",
        f"metric {usb_metric}",
        "",
        f"interface {fallback_iface}",
        f"metric {fallback_metric}",
        end_marker,
    ]
)

lines = content.splitlines()
filtered = []
skip = False
for line in lines:
    if line == start_marker:
        skip = True
        continue
    if skip and line == end_marker:
        skip = False
        continue
    if not skip:
        filtered.append(line)

while filtered and filtered[-1] == "":
    filtered.pop()

filtered.append("")
filtered.append(block)
target_path.write_text("\n".join(filtered) + "\n", encoding="utf-8")
PY
  sudo install -m 0644 "${tmp_file}" /etc/dhcpcd.conf
  rm -f "${tmp_file}"
}

connect_with_networkmanager() {
  reused_existing_profile="0"
  active_fallback_conn="$(sudo nmcli -t -f NAME,DEVICE connection show --active | awk -F: -v dev="${FALLBACK_IFACE}" '$2==dev {print $1; exit}')"

  sudo nmcli radio wifi on >/dev/null 2>&1 || true
  sudo nmcli device set "${USB_IFACE}" managed yes >/dev/null 2>&1 || true
  bring_iface_up "${USB_IFACE}"

  if [ -n "${SCOREBOARD_WIFI_SSID}" ] && [ -n "${SCOREBOARD_WIFI_PSK}" ]; then
    sudo nmcli device wifi connect "${SCOREBOARD_WIFI_SSID}" password "${SCOREBOARD_WIFI_PSK}" ifname "${USB_IFACE}" name "scoreboard-${USB_IFACE}" >/dev/null
  else
    reused_existing_profile="1"
    if [ -n "${active_fallback_conn}" ]; then
      sudo nmcli connection up id "${active_fallback_conn}" ifname "${USB_IFACE}" >/dev/null || sudo nmcli device connect "${USB_IFACE}" >/dev/null
    else
      sudo nmcli device connect "${USB_IFACE}" >/dev/null
    fi
  fi

  usb_connection_name="$(sudo nmcli -t -f GENERAL.CONNECTION device show "${USB_IFACE}" | awk -F: '/GENERAL\.CONNECTION/ {print $2; exit}')"

  sudo nmcli device modify "${USB_IFACE}" ipv4.route-metric "${USB_METRIC}" ipv6.route-metric "${USB_METRIC}" >/dev/null 2>&1 || true
  if have_iface "${FALLBACK_IFACE}"; then
    sudo nmcli device modify "${FALLBACK_IFACE}" ipv4.route-metric "${FALLBACK_METRIC}" ipv6.route-metric "${FALLBACK_METRIC}" >/dev/null 2>&1 || true
  fi

  if [ "${reused_existing_profile}" = "0" ] && [ -n "${usb_connection_name}" ] && [ "${usb_connection_name}" != "--" ]; then
    sudo nmcli connection modify "${usb_connection_name}" connection.autoconnect yes connection.autoconnect-priority 100 connection.interface-name "${USB_IFACE}" ipv4.route-metric "${USB_METRIC}" ipv6.route-metric "${USB_METRIC}" >/dev/null 2>&1 || true
  fi

  if [ -n "${active_fallback_conn}" ] && [ "${active_fallback_conn}" != "${usb_connection_name}" ]; then
    sudo nmcli connection modify "${active_fallback_conn}" connection.autoconnect yes connection.autoconnect-priority 10 ipv4.route-metric "${FALLBACK_METRIC}" ipv6.route-metric "${FALLBACK_METRIC}" >/dev/null 2>&1 || true
  fi

  wait_for_default_route "${USB_IFACE}"
}

connect_with_wpa_supplicant() {
  if [ -z "${SCOREBOARD_WIFI_SSID}" ] || [ -z "${SCOREBOARD_WIFI_PSK}" ]; then
    warn "wpa_supplicant fallback requires SCOREBOARD_WIFI_SSID and SCOREBOARD_WIFI_PSK in ${ENV_FILE}."
    return 1
  fi

  if ! command -v wpa_passphrase >/dev/null 2>&1; then
    warn "wpa_passphrase is not available, so the installer cannot build a wlan1 config."
    return 1
  fi

  bring_iface_up "${USB_IFACE}"

  tmp_cfg="$(mktemp)"
  {
    printf 'ctrl_interface=DIR=/run/wpa_supplicant GROUP=netdev\n'
    printf 'update_config=0\n'
    printf 'country=%s\n' "${WIFI_COUNTRY}"
    wpa_passphrase "${SCOREBOARD_WIFI_SSID}" "${SCOREBOARD_WIFI_PSK}"
  } > "${tmp_cfg}"

  sudo install -m 0600 "${tmp_cfg}" "/etc/wpa_supplicant/wpa_supplicant-${USB_IFACE}.conf"
  rm -f "${tmp_cfg}"

  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl enable "wpa_supplicant@${USB_IFACE}.service" >/dev/null 2>&1 || true
    sudo systemctl restart "wpa_supplicant@${USB_IFACE}.service" >/dev/null 2>&1 || true
  fi

  if command -v dhcpcd >/dev/null 2>&1; then
    sudo dhcpcd -n "${USB_IFACE}" >/dev/null 2>&1 || true
  elif command -v dhclient >/dev/null 2>&1; then
    sudo dhclient "${USB_IFACE}" >/dev/null 2>&1 || true
  fi

  wait_for_default_route "${USB_IFACE}"
}

reconnect_fallback_iface() {
  if ! have_iface "${FALLBACK_IFACE}"; then
    return
  fi

  bring_iface_up "${FALLBACK_IFACE}" || true
  if networkmanager_available; then
    sudo nmcli device connect "${FALLBACK_IFACE}" >/dev/null 2>&1 || true
  fi
}

disable_fallback_iface() {
  if [ "${DISABLE_FALLBACK_ON_SUCCESS}" != "1" ]; then
    return
  fi

  if ! have_iface "${FALLBACK_IFACE}"; then
    return
  fi

  if networkmanager_available; then
    sudo nmcli device disconnect "${FALLBACK_IFACE}" >/dev/null 2>&1 || true
  fi
  sudo ip link set "${FALLBACK_IFACE}" down >/dev/null 2>&1 || true
}

load_env_overrides
USB_IFACE="${SCOREBOARD_WIFI_USB_IFACE:-${USB_IFACE}}"
FALLBACK_IFACE="${SCOREBOARD_WIFI_FALLBACK_IFACE:-${FALLBACK_IFACE}}"
USB_METRIC="${SCOREBOARD_WIFI_USB_METRIC:-${USB_METRIC}}"
FALLBACK_METRIC="${SCOREBOARD_WIFI_FALLBACK_METRIC:-${FALLBACK_METRIC}}"
WIFI_COUNTRY="${SCOREBOARD_WIFI_COUNTRY:-${WIFI_COUNTRY}}"
DISABLE_FALLBACK_ON_SUCCESS="${SCOREBOARD_WIFI_DISABLE_WLAN0:-${DISABLE_FALLBACK_ON_SUCCESS}}"

if ! adapter_present; then
  log "USB adapter ${USB_ADAPTER_ID} was not detected on ${USB_IFACE}; skipping switchover."
  exit 0
fi

if ! have_iface "${USB_IFACE}"; then
  warn "${USB_IFACE} was not created even though the USB adapter appears present."
  exit 1
fi

if ! driver_is_loaded; then
  warn "The expected Realtek driver (${USB_DRIVER_PATTERN}) is not loaded. Continuing anyway."
fi

log "Attempting Wi-Fi switchover from ${FALLBACK_IFACE} to ${USB_IFACE}."

if networkmanager_available; then
  if connect_with_networkmanager; then
    write_dhcpcd_metrics
    disable_fallback_iface
    log "Default route now prefers ${USB_IFACE}:"
    ip route show default
    exit 0
  fi

  warn "NetworkManager could not move the active connection to ${USB_IFACE}."
else
  log "NetworkManager is not active; trying wpa_supplicant management."
fi

if connect_with_wpa_supplicant; then
  write_dhcpcd_metrics
  disable_fallback_iface
  log "Default route now prefers ${USB_IFACE}:"
  ip route show default
  exit 0
fi

warn "USB Wi-Fi switchover failed. Re-enabling ${FALLBACK_IFACE}."
reconnect_fallback_iface
exit 1
