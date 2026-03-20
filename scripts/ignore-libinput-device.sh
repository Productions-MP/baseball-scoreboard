#!/usr/bin/env bash
set -eu

RULES_DIR="/etc/udev/rules.d"
DEFAULT_RULE_PATH="${RULES_DIR}/99-scoreboard-ignore-pointer.rules"

usage() {
  cat <<'EOF'
Usage:
  ignore-libinput-device.sh list
  ignore-libinput-device.sh preview /dev/input/eventX
  ignore-libinput-device.sh apply /dev/input/eventX [rule-path]

Commands:
  list      Show libinput devices with pointer capability.
  preview   Print a udev rule that would ignore the given event device.
  apply     Install the udev rule, reload udev, and trigger the device.

Examples:
  ./ignore-libinput-device.sh list
  ./ignore-libinput-device.sh preview /dev/input/event5
  sudo ./ignore-libinput-device.sh apply /dev/input/event5
EOF
}

require_command() {
  command_name="$1"
  package_hint="$2"

  if command -v "${command_name}" >/dev/null 2>&1; then
    return 0
  fi

  echo "Missing command: ${command_name}. Install ${package_hint} and try again." >&2
  exit 1
}

list_pointer_devices() {
  require_command "libinput" "libinput-tools"

  if ! libinput list-devices | awk '
    BEGIN { RS=""; ORS="\n\n"; found=0 }
    /Capabilities:[[:space:]].*pointer/ { print; found=1 }
    END { if (!found) exit 1 }
  '; then
    echo "No libinput pointer-capable devices were found." >&2
    exit 1
  fi
}

read_property() {
  properties="$1"
  key="$2"
  printf '%s\n' "${properties}" | awk -F= -v wanted="${key}" '$1 == wanted { print substr($0, length($1) + 2); exit }'
}

build_rule() {
  device_node="$1"

  require_command "udevadm" "udev"

  if [ ! -e "${device_node}" ]; then
    echo "Device does not exist: ${device_node}" >&2
    exit 1
  fi

  properties="$(udevadm info --query=property --name "${device_node}")"

  vendor_id="$(read_property "${properties}" "ID_VENDOR_ID")"
  model_id="$(read_property "${properties}" "ID_MODEL_ID")"
  id_path="$(read_property "${properties}" "ID_PATH")"
  id_serial="$(read_property "${properties}" "ID_SERIAL")"
  id_bus="$(read_property "${properties}" "ID_BUS")"
  device_name="$(read_property "${properties}" "NAME")"

  if [ -z "${vendor_id}${model_id}${id_path}${id_serial}${id_bus}" ]; then
    echo "Could not find stable udev identifiers for ${device_node}." >&2
    echo "Run 'udevadm info --query=property --name ${device_node}' and build a manual rule." >&2
    exit 1
  fi

  printf '# Ignore pointer-like device for scoreboard kiosk\n'
  printf '# Source device: %s\n' "${device_node}"

  if [ -n "${device_name}" ]; then
    printf '# Reported name: %s\n' "${device_name}"
  fi

  printf 'ACTION!="remove", SUBSYSTEM=="input", KERNEL=="event*", '

  matched_any="0"

  if [ -n "${id_bus}" ]; then
    printf 'ENV{ID_BUS}=="%s", ' "${id_bus}"
    matched_any="1"
  fi

  if [ -n "${vendor_id}" ]; then
    printf 'ENV{ID_VENDOR_ID}=="%s", ' "${vendor_id}"
    matched_any="1"
  fi

  if [ -n "${model_id}" ]; then
    printf 'ENV{ID_MODEL_ID}=="%s", ' "${model_id}"
    matched_any="1"
  fi

  if [ -n "${id_path}" ]; then
    printf 'ENV{ID_PATH}=="%s", ' "${id_path}"
    matched_any="1"
  elif [ -n "${id_serial}" ]; then
    printf 'ENV{ID_SERIAL}=="%s", ' "${id_serial}"
    matched_any="1"
  fi

  if [ "${matched_any}" != "1" ]; then
    echo "Could not build a safe rule for ${device_node}." >&2
    exit 1
  fi

  printf 'ENV{LIBINPUT_IGNORE_DEVICE}="1"\n'
}

apply_rule() {
  device_node="$1"
  rule_path="${2:-${DEFAULT_RULE_PATH}}"

  if [ "$(id -u)" -ne 0 ]; then
    echo "apply must be run as root." >&2
    exit 1
  fi

  tmp_rule="$(mktemp)"
  trap 'rm -f "${tmp_rule}"' EXIT

  build_rule "${device_node}" > "${tmp_rule}"
  install -m 0644 "${tmp_rule}" "${rule_path}"
  udevadm control --reload
  udevadm trigger --name-match "$(basename "${device_node}")"

  echo "Installed ${rule_path}"
  echo "Reboot or restart the kiosk service if the cursor device is still active."
}

command_name="${1:-}"

case "${command_name}" in
  list)
    list_pointer_devices
    ;;
  preview)
    if [ "$#" -ne 2 ]; then
      usage
      exit 1
    fi
    build_rule "$2"
    ;;
  apply)
    if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
      usage
      exit 1
    fi
    apply_rule "$2" "${3:-${DEFAULT_RULE_PATH}}"
    ;;
  *)
    usage
    exit 1
    ;;
esac
