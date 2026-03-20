#!/usr/bin/env bash
set -eu

SERVICE_NAME="scoreboard-display.service"

if [ "$(id -u)" -eq 0 ]; then
  exec systemctl restart "${SERVICE_NAME}"
fi

exec sudo systemctl restart "${SERVICE_NAME}"
