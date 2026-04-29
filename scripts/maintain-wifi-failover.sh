#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${APP_ROOT}/.env"
USB_IFACE="${SCOREBOARD_WIFI_USB_IFACE:-wlan1}"
FALLBACK_IFACE="${SCOREBOARD_WIFI_FALLBACK_IFACE:-wlan0}"
USB_ADAPTER_ID="${SCOREBOARD_WIFI_USB_ADAPTER_ID:-0bda:c811}"
ALLOW_FALLBACK="${SCOREBOARD_WIFI_ALLOW_FALLBACK:-1}"
PRIMARY_RECOVERY_GRACE_SECONDS="${SCOREBOARD_WIFI_PRIMARY_RECOVERY_GRACE_SECONDS:-180}"
PRIMARY_REBOOT_SECONDS="${SCOREBOARD_WIFI_PRIMARY_REBOOT_SECONDS:-900}"
PRIMARY_REBOOT_MAX_SECONDS="${SCOREBOARD_WIFI_PRIMARY_REBOOT_MAX_SECONDS:-21600}"
STATE_DIR="${SCOREBOARD_WIFI_STATE_DIR:-/run/scoreboard}"
STATE_FILE="${STATE_DIR}/wifi-failover-primary.state"
REBOOT_STATE_DIR="${SCOREBOARD_WIFI_REBOOT_STATE_DIR:-/var/lib/scoreboard}"
REBOOT_STATE_FILE="${REBOOT_STATE_DIR}/wifi-failover-primary-reboot-delay.state"
PRIMARY_CONN="scoreboard-${USB_IFACE}"
FALLBACK_CONN="scoreboard-${FALLBACK_IFACE}"

log() {
  echo "[wifi-failover] $*"
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
    "SCOREBOARD_WIFI_USB_IFACE",
    "SCOREBOARD_WIFI_FALLBACK_IFACE",
    "SCOREBOARD_WIFI_ALLOW_FALLBACK",
    "SCOREBOARD_WIFI_PRIMARY_RECOVERY_GRACE_SECONDS",
    "SCOREBOARD_WIFI_PRIMARY_REBOOT_SECONDS",
    "SCOREBOARD_WIFI_PRIMARY_REBOOT_MAX_SECONDS",
    "SCOREBOARD_WIFI_STATE_DIR",
    "SCOREBOARD_WIFI_REBOOT_STATE_DIR",
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

  return 1
}

default_route_uses_iface() {
  ip route show default 2>/dev/null | grep -q " dev $1"
}

fallback_enabled() {
  [ "${ALLOW_FALLBACK}" = "1" ]
}

ensure_state_dir() {
  mkdir -p "${STATE_DIR}"
}

ensure_reboot_state_dir() {
  mkdir -p "${REBOOT_STATE_DIR}"
}

clear_primary_failure_state() {
  rm -f "${STATE_FILE}"
  rm -f "${REBOOT_STATE_FILE}"
}

mark_primary_failure_start() {
  if [ -f "${STATE_FILE}" ]; then
    return
  fi

  ensure_state_dir
  date +%s > "${STATE_FILE}"
}

primary_failure_started_at() {
  if [ ! -f "${STATE_FILE}" ]; then
    return 1
  fi

  cat "${STATE_FILE}" 2>/dev/null
}

primary_failure_age() {
  started_at="$(primary_failure_started_at)" || return 1
  now="$(date +%s)"
  age=$((now - started_at))
  if [ "${age}" -lt 0 ]; then
    age=0
  fi
  printf '%s\n' "${age}"
}

current_primary_reboot_seconds() {
  if [ -f "${REBOOT_STATE_FILE}" ]; then
    reboot_seconds="$(cat "${REBOOT_STATE_FILE}" 2>/dev/null || printf '%s\n' "${PRIMARY_REBOOT_SECONDS}")"
  else
    reboot_seconds="${PRIMARY_REBOOT_SECONDS}"
  fi

  case "${reboot_seconds}" in
    ''|*[!0-9]*)
      reboot_seconds="${PRIMARY_REBOOT_SECONDS}"
      ;;
  esac

  if [ "${PRIMARY_REBOOT_MAX_SECONDS}" -gt 0 ] && [ "${reboot_seconds}" -gt "${PRIMARY_REBOOT_MAX_SECONDS}" ]; then
    reboot_seconds="${PRIMARY_REBOOT_MAX_SECONDS}"
  fi

  printf '%s\n' "${reboot_seconds}"
}

record_primary_reboot_attempt() {
  reboot_seconds="$(current_primary_reboot_seconds)"
  next_reboot_seconds=$((reboot_seconds * 2))

  if [ "${PRIMARY_REBOOT_MAX_SECONDS}" -gt 0 ] && [ "${next_reboot_seconds}" -gt "${PRIMARY_REBOOT_MAX_SECONDS}" ]; then
    next_reboot_seconds="${PRIMARY_REBOOT_MAX_SECONDS}"
  fi

  ensure_reboot_state_dir
  printf '%s\n' "${next_reboot_seconds}" > "${REBOOT_STATE_FILE}"
}

reboot_after_extended_primary_failure() {
  if [ "${PRIMARY_REBOOT_SECONDS}" -le 0 ]; then
    return
  fi

  failure_age="$(primary_failure_age || printf '0\n')"
  reboot_seconds="$(current_primary_reboot_seconds)"
  if [ "${failure_age}" -lt "${reboot_seconds}" ]; then
    return
  fi

  record_primary_reboot_attempt
  next_reboot_seconds="$(current_primary_reboot_seconds)"
  log "Primary Wi-Fi has been unhealthy for ${failure_age}s, exceeding the current reboot threshold of ${reboot_seconds}s; rebooting the Pi. Next unresolved outage threshold is ${next_reboot_seconds}s."
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl reboot
  else
    sudo shutdown -r now
  fi
  exit 1
}

wait_for_default_route() {
  iface="$1"
  attempts="${2:-10}"

  while [ "${attempts}" -gt 0 ]; do
    if default_route_uses_iface "${iface}"; then
      return 0
    fi
    sleep 1
    attempts=$((attempts - 1))
  done

  return 1
}

nm_connection_exists() {
  sudo nmcli -t -f NAME connection show | grep -Fxq "$1"
}

bring_up_connection() {
  conn="$1"
  iface="$2"

  if ! nm_connection_exists "${conn}"; then
    return 1
  fi

  sudo nmcli device set "${iface}" managed yes >/dev/null 2>&1 || true
  sudo ip link set "${iface}" up >/dev/null 2>&1 || true
  sudo nmcli connection up id "${conn}" ifname "${iface}" >/dev/null 2>&1 || return 1
  return 0
}

disconnect_connection() {
  conn="$1"
  iface="$2"

  if nm_connection_exists "${conn}"; then
    sudo nmcli connection down id "${conn}" >/dev/null 2>&1 || true
  fi
  sudo nmcli device disconnect "${iface}" >/dev/null 2>&1 || true
}

keep_fallback_down() {
  if ! have_iface "${FALLBACK_IFACE}"; then
    return
  fi

  sudo nmcli device set "${FALLBACK_IFACE}" managed yes >/dev/null 2>&1 || true
  sudo nmcli device set "${FALLBACK_IFACE}" autoconnect no >/dev/null 2>&1 || true
  disconnect_connection "${FALLBACK_CONN}" "${FALLBACK_IFACE}"
  sudo ip link set "${FALLBACK_IFACE}" down >/dev/null 2>&1 || true
}

load_env_overrides
USB_IFACE="${SCOREBOARD_WIFI_USB_IFACE:-${USB_IFACE}}"
FALLBACK_IFACE="${SCOREBOARD_WIFI_FALLBACK_IFACE:-${FALLBACK_IFACE}}"
ALLOW_FALLBACK="${SCOREBOARD_WIFI_ALLOW_FALLBACK:-${ALLOW_FALLBACK}}"
PRIMARY_REBOOT_SECONDS="${SCOREBOARD_WIFI_PRIMARY_REBOOT_SECONDS:-${PRIMARY_REBOOT_SECONDS}}"
PRIMARY_REBOOT_MAX_SECONDS="${SCOREBOARD_WIFI_PRIMARY_REBOOT_MAX_SECONDS:-${PRIMARY_REBOOT_MAX_SECONDS}}"
REBOOT_STATE_DIR="${SCOREBOARD_WIFI_REBOOT_STATE_DIR:-${REBOOT_STATE_DIR}}"
REBOOT_STATE_FILE="${REBOOT_STATE_DIR}/wifi-failover-primary-reboot-delay.state"
PRIMARY_CONN="scoreboard-${USB_IFACE}"
FALLBACK_CONN="scoreboard-${FALLBACK_IFACE}"

if ! command -v nmcli >/dev/null 2>&1; then
  log "NetworkManager is not available; skipping automatic failover."
  exit 0
fi

if adapter_present && have_iface "${USB_IFACE}"; then
  if default_route_uses_iface "${USB_IFACE}"; then
    clear_primary_failure_state
    keep_fallback_down
    exit 0
  fi

  if bring_up_connection "${PRIMARY_CONN}" "${USB_IFACE}" && wait_for_default_route "${USB_IFACE}" 12; then
    clear_primary_failure_state
    log "Primary Wi-Fi restored on ${USB_IFACE}; disconnecting ${FALLBACK_IFACE}."
    keep_fallback_down
    exit 0
  fi
fi

if adapter_present; then
  mark_primary_failure_start
  reboot_after_extended_primary_failure
else
  clear_primary_failure_state
fi

if ! fallback_enabled; then
  keep_fallback_down
  log "USB Wi-Fi is configured as the only allowed uplink; keeping ${FALLBACK_IFACE} offline while retrying ${USB_IFACE}."
  exit 1
fi

if adapter_present && have_iface "${USB_IFACE}"; then
  failure_age="$(primary_failure_age || printf '0\n')"
  if [ "${failure_age}" -lt "${PRIMARY_RECOVERY_GRACE_SECONDS}" ]; then
    remaining=$((PRIMARY_RECOVERY_GRACE_SECONDS - failure_age))
    keep_fallback_down
    log "Primary Wi-Fi on ${USB_IFACE} is still within its recovery grace window (${failure_age}s/${PRIMARY_RECOVERY_GRACE_SECONDS}s); keeping ${FALLBACK_IFACE} offline for ${remaining}s more."
    exit 1
  fi
fi

if have_iface "${FALLBACK_IFACE}" && bring_up_connection "${FALLBACK_CONN}" "${FALLBACK_IFACE}"; then
  if wait_for_default_route "${FALLBACK_IFACE}" 12; then
    log "Fallback Wi-Fi active on ${FALLBACK_IFACE}."
    exit 0
  fi
fi

log "No Wi-Fi failover route could be established."
exit 1
