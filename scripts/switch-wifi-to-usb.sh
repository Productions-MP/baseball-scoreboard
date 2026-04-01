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
NM_CONFIG_DIR="/etc/NetworkManager/conf.d"
NM_MANAGED_CONFIG="${NM_CONFIG_DIR}/90-scoreboard-wifi-managed.conf"
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

write_networkmanager_device_policy() {
  tmp_file="$(mktemp)"
  cat > "${tmp_file}" <<EOF
[device-scoreboard-${USB_IFACE}]
match-device=interface-name:${USB_IFACE}
managed=1

[device-scoreboard-${FALLBACK_IFACE}]
match-device=interface-name:${FALLBACK_IFACE}
managed=1
EOF
  sudo install -d -m 0755 "${NM_CONFIG_DIR}"
  sudo install -m 0644 "${tmp_file}" "${NM_MANAGED_CONFIG}"
  rm -f "${tmp_file}"
}

reload_networkmanager() {
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl reload NetworkManager >/dev/null 2>&1 || true
  fi
  sudo nmcli general reload >/dev/null 2>&1 || true
}

nm_device_state() {
  sudo nmcli -t -f DEVICE,STATE device status | awk -F: -v dev="$1" '$1==dev {print $2; exit}'
}

wait_for_nm_device_ready() {
  iface="$1"
  attempts="${2:-15}"

  while [ "${attempts}" -gt 0 ]; do
    state="$(nm_device_state "${iface}")"

    case "${state}" in
      disconnected|connecting*|connected*)
        return 0
        ;;
      unavailable|unmanaged)
        sudo nmcli device set "${iface}" managed yes >/dev/null 2>&1 || true
        bring_iface_up "${iface}" || true
        if command -v rfkill >/dev/null 2>&1; then
          sudo rfkill unblock wifi >/dev/null 2>&1 || true
        fi
        ;;
    esac

    sleep 1
    attempts=$((attempts - 1))
  done

  warn "NetworkManager still reports ${iface} as '${state:-unknown}'."
  return 1
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

ensure_nm_wifi_profile() {
  profile_name="$1"
  iface="$2"
  metric="$3"
  priority="$4"
  autoconnect="$5"

  if sudo nmcli -t -f NAME connection show | grep -Fxq "${profile_name}"; then
    sudo nmcli connection modify "${profile_name}" \
      connection.interface-name "${iface}" \
      802-11-wireless.ssid "${SCOREBOARD_WIFI_SSID}" >/dev/null
  else
    sudo nmcli connection add type wifi ifname "${iface}" con-name "${profile_name}" ssid "${SCOREBOARD_WIFI_SSID}" >/dev/null
  fi

  sudo nmcli connection modify "${profile_name}" \
    connection.interface-name "${iface}" \
    connection.autoconnect "${autoconnect}" \
    connection.autoconnect-priority "${priority}" \
    connection.autoconnect-retries 0 \
    connection.wait-device-timeout 30000 \
    802-11-wireless.mode infrastructure \
    802-11-wireless-security.key-mgmt wpa-psk \
    802-11-wireless-security.psk "${SCOREBOARD_WIFI_PSK}" \
    ipv4.route-metric "${metric}" \
    ipv6.route-metric "${metric}" >/dev/null
}

configure_networkmanager_profiles() {
  usb_connection_name="scoreboard-${USB_IFACE}"
  fallback_connection_name="scoreboard-${FALLBACK_IFACE}"

  if [ -z "${SCOREBOARD_WIFI_SSID}" ] || [ -z "${SCOREBOARD_WIFI_PSK}" ]; then
    warn "Persistent NetworkManager setup requires SCOREBOARD_WIFI_SSID and SCOREBOARD_WIFI_PSK in ${ENV_FILE}."
    return 1
  fi

  write_networkmanager_device_policy
  reload_networkmanager
  sudo nmcli radio wifi on >/dev/null 2>&1 || true
  sudo nmcli device set "${USB_IFACE}" managed yes >/dev/null 2>&1 || true
  if have_iface "${FALLBACK_IFACE}"; then
    sudo nmcli device set "${FALLBACK_IFACE}" managed yes >/dev/null 2>&1 || true
  fi
  bring_iface_up "${USB_IFACE}"
  if have_iface "${FALLBACK_IFACE}"; then
    bring_iface_up "${FALLBACK_IFACE}" || true
  fi
  wait_for_nm_device_ready "${USB_IFACE}"
  if have_iface "${FALLBACK_IFACE}"; then
    wait_for_nm_device_ready "${FALLBACK_IFACE}" 5 || true
  fi

  ensure_nm_wifi_profile "${usb_connection_name}" "${USB_IFACE}" "${USB_METRIC}" 100 yes
  if have_iface "${FALLBACK_IFACE}"; then
    ensure_nm_wifi_profile "${fallback_connection_name}" "${FALLBACK_IFACE}" "${FALLBACK_METRIC}" 10 no
  fi

  sudo nmcli device modify "${USB_IFACE}" ipv4.route-metric "${USB_METRIC}" ipv6.route-metric "${USB_METRIC}" >/dev/null 2>&1 || true
  if have_iface "${FALLBACK_IFACE}"; then
    sudo nmcli device modify "${FALLBACK_IFACE}" ipv4.route-metric "${FALLBACK_METRIC}" ipv6.route-metric "${FALLBACK_METRIC}" >/dev/null 2>&1 || true
  fi

  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl disable --now "wpa_supplicant@${USB_IFACE}.service" >/dev/null 2>&1 || true
  fi
  sudo rm -f "/etc/wpa_supplicant/wpa_supplicant-${USB_IFACE}.conf"

  sudo nmcli connection up id "${usb_connection_name}" ifname "${USB_IFACE}" >/dev/null
  wait_for_default_route "${USB_IFACE}"

  if [ "${DISABLE_FALLBACK_ON_SUCCESS}" = "1" ] && have_iface "${FALLBACK_IFACE}"; then
    sudo nmcli connection down id "${fallback_connection_name}" >/dev/null 2>&1 || true
    sudo nmcli device disconnect "${FALLBACK_IFACE}" >/dev/null 2>&1 || true
  fi

  log "NetworkManager profiles installed: ${usb_connection_name} auto-connects, ${fallback_connection_name} is standby only."
}

connect_with_networkmanager() {
  configure_networkmanager_profiles
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
    sudo nmcli connection up id "scoreboard-${FALLBACK_IFACE}" ifname "${FALLBACK_IFACE}" >/dev/null 2>&1 || sudo nmcli device connect "${FALLBACK_IFACE}" >/dev/null 2>&1 || true
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
