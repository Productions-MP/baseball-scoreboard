import hmac
import json
import logging
import os
import shutil
import subprocess
import threading
from datetime import datetime, timezone

from flask import Flask, jsonify, redirect, render_template, request, send_from_directory
from flask_sock import Sock
from simple_websocket import ConnectionClosed
from shared.scoreboard_core import apply_action, build_reset_state, clone_default_state, merge_state, normalize_state, with_derived
from shared.scoreboard_designs import DEFAULT_SCOREBOARD_DESIGN_ID, get_scoreboard_design, list_scoreboard_designs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILES = (
    os.path.join(BASE_DIR, "pi-fallback", "pi.env"),
    os.path.join(BASE_DIR, "pi.env"),
    os.path.join(BASE_DIR, ".env"),
)
MODE_NAME = "scoreboard"
LOGGER = logging.getLogger("scoreboard-web")

STATE_LOCK = threading.Lock()
CLIENTS_LOCK = threading.Lock()
SEND_LOCK = threading.Lock()
WS_CLIENTS = set()

SYSTEM_ACTIONS = {
    "restart-scoreboard": {
        "command": ["systemctl", "restart", "scoreboard-local.service", "scoreboard-display.service"],
        "message": "Restart Application requested. The controller may disconnect while the scoreboard restarts.",
    },
    "reboot-pi": {
        "command": ["shutdown", "-r", "now"],
        "message": "Reboot Scoreboard requested. The Pi will disconnect while it restarts.",
    },
    "shutdown-pi": {
        "command": ["shutdown", "now"],
        "message": "Shutdown Scoreboard requested. The Pi will power off shortly.",
    },
}
WIFI_SETTING_DEFAULTS = {
    "SCOREBOARD_WIFI_ALLOW_FALLBACK": "1",
    "SCOREBOARD_WIFI_PRIMARY_RECOVERY_GRACE_SECONDS": "180",
}
DISPLAY_IDLE_SETTING_DEFAULTS = {
    "SCOREBOARD_SCREENSAVER_IDLE_SECONDS": "900",
    "SCOREBOARD_BLACKOUT_IDLE_SECONDS": "1800",
}

def load_env_file(path):
    if not os.path.exists(path):
        return

    with open(path, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def env_value(primary_name, legacy_name=None, default=""):
    value = os.environ.get(primary_name)

    if value is None and legacy_name:
        value = os.environ.get(legacy_name)

    if value is None:
        return default

    return value


def int_env_value(primary_name, legacy_name=None, default=0):
    raw_value = env_value(primary_name, legacy_name, str(default))

    try:
        return int(str(raw_value).strip())
    except (TypeError, ValueError):
        return int(default)


def strip_wrapping_quotes(value):
    text = str(value or "").strip()

    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        return text[1:-1]

    return text


for env_file in ENV_FILES:
    load_env_file(env_file)

DEFAULT_STATE_FILE = os.path.join(BASE_DIR, "runtime", "scoreboard_state.json")
LEGACY_STATE_FILE = os.path.join(BASE_DIR, "pi-fallback", "runtime", "scoreboard_state.json")

STATE_FILE = env_value(
    "SCOREBOARD_STATE_FILE",
    "FALLBACK_STATE_FILE",
    LEGACY_STATE_FILE if os.path.exists(LEGACY_STATE_FILE) and not os.path.exists(DEFAULT_STATE_FILE) else DEFAULT_STATE_FILE,
)
SCOREBOARD_HOST = env_value("SCOREBOARD_HOST", "FALLBACK_HOST", "0.0.0.0")
SCOREBOARD_PORT = int_env_value("SCOREBOARD_PORT", "FALLBACK_PORT", 5050)
SCHOOL_NAME = env_value("SCHOOL_NAME", default="Highlands Latin School")

app = Flask(__name__)
sock = Sock(app)


def stamp_state(state):
    return {
        **normalize_state(state),
        "updated_at": isoformat_utc(now_utc()),
        "source": MODE_NAME,
    }


def now_utc():
    return datetime.now(timezone.utc)


def isoformat_utc(value):
    return value.isoformat().replace("+00:00", "Z")


def atomic_write_state(payload):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    temp_path = STATE_FILE + ".tmp"

    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")

    os.replace(temp_path, STATE_FILE)


def read_state():
    with STATE_LOCK:
        if not os.path.exists(STATE_FILE):
            seeded = stamp_state(clone_default_state())
            atomic_write_state(seeded)
            return seeded

        try:
            with open(STATE_FILE, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, json.JSONDecodeError):
            reset_state = stamp_state(clone_default_state())
            atomic_write_state(reset_state)
            return reset_state

    return {
        **normalize_state(data),
        "updated_at": data.get("updated_at"),
        "source": data.get("source", MODE_NAME),
    }


def write_state(next_state):
    stamped = stamp_state(next_state)

    with STATE_LOCK:
        atomic_write_state(stamped)

    return stamped


def read_control_key():
    return env_value("SCOREBOARD_CONTROL_KEY", "FALLBACK_CONTROL_KEY", "").strip()


def control_key_is_valid(provided_key):
    expected_key = read_control_key()

    if not expected_key:
        return True

    provided = str(provided_key or "").strip()
    return bool(provided) and hmac.compare_digest(expected_key, provided)


def control_key_error():
    return jsonify({"ok": False, "error": "Unauthorized. Provide a valid control key."}), 401


def require_control_key():
    if control_key_is_valid(request.headers.get("x-scoreboard-key", "")):
        return None

    return control_key_error()


def api_payload(state):
    display_idle_settings = read_display_idle_settings()
    return {
        "ok": True,
        "mode": MODE_NAME,
        "updated_at": state.get("updated_at"),
        "screensaver_idle_seconds": display_idle_settings["screensaver_idle_seconds"],
        "blackout_idle_seconds": display_idle_settings["blackout_idle_seconds"],
        "state": with_derived(state, default_source=MODE_NAME),
    }


def state_message(state, request_id=None):
    payload = api_payload(state)
    payload["type"] = "state"

    if request_id:
        payload["request_id"] = request_id

    return payload


def error_message(message, status=400, request_id=None):
    payload = {
        "ok": False,
        "type": "error",
        "status": status,
        "error": message,
    }

    if request_id:
        payload["request_id"] = request_id

    return payload


def safe_send(client, payload):
    message = payload if isinstance(payload, str) else json.dumps(payload)

    with SEND_LOCK:
        client.send(message)


def register_client(client):
    with CLIENTS_LOCK:
        WS_CLIENTS.add(client)


def unregister_client(client):
    with CLIENTS_LOCK:
        WS_CLIENTS.discard(client)


def broadcast_payload(payload):
    stale_clients = []

    with CLIENTS_LOCK:
        clients = list(WS_CLIENTS)

    for client in clients:
        try:
            safe_send(client, payload)
        except Exception:
            stale_clients.append(client)

    if stale_clients:
        with CLIENTS_LOCK:
            for client in stale_clients:
                WS_CLIENTS.discard(client)


def broadcast_state(state, request_id=None):
    broadcast_payload(state_message(state, request_id=request_id))


def parse_state_patch(value):
    if value is None:
        return {}

    if not isinstance(value, dict):
        raise ValueError("State payload must be a JSON object.")

    return value


def parse_action_name(value):
    action_name = str(value or "").strip()

    if not action_name:
        raise ValueError("Action name is required.")

    return action_name


def parse_system_action(value):
    action_name = parse_action_name(value)

    if action_name not in SYSTEM_ACTIONS:
        raise ValueError("Unsupported system action.")

    return action_name


def resolve_env_file_path():
    for path in ENV_FILES:
        if os.path.exists(path):
            return path

    return ENV_FILES[-1]


def read_env_assignments(path):
    assignments = {}

    if not os.path.exists(path):
        return assignments

    with open(path, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            stripped = raw_line.strip()
            if not stripped or stripped.startswith("#") or "=" not in raw_line:
                continue

            key, value = raw_line.split("=", 1)
            assignments[key.strip()] = strip_wrapping_quotes(value)

    return assignments


def read_wifi_settings():
    env_path = resolve_env_file_path()
    assignments = read_env_assignments(env_path)
    allow_fallback_raw = assignments.get(
        "SCOREBOARD_WIFI_ALLOW_FALLBACK",
        os.environ.get("SCOREBOARD_WIFI_ALLOW_FALLBACK", WIFI_SETTING_DEFAULTS["SCOREBOARD_WIFI_ALLOW_FALLBACK"]),
    )
    grace_raw = assignments.get(
        "SCOREBOARD_WIFI_PRIMARY_RECOVERY_GRACE_SECONDS",
        os.environ.get(
            "SCOREBOARD_WIFI_PRIMARY_RECOVERY_GRACE_SECONDS",
            WIFI_SETTING_DEFAULTS["SCOREBOARD_WIFI_PRIMARY_RECOVERY_GRACE_SECONDS"],
        ),
    )

    try:
        grace_seconds = int(str(grace_raw).strip() or WIFI_SETTING_DEFAULTS["SCOREBOARD_WIFI_PRIMARY_RECOVERY_GRACE_SECONDS"])
    except ValueError:
        grace_seconds = int(WIFI_SETTING_DEFAULTS["SCOREBOARD_WIFI_PRIMARY_RECOVERY_GRACE_SECONDS"])

    return {
        "env_file": env_path,
        "allow_fallback": str(allow_fallback_raw).strip() != "0",
        "primary_recovery_grace_seconds": max(0, grace_seconds),
    }


def read_display_idle_settings():
    env_path = resolve_env_file_path()
    assignments = read_env_assignments(env_path)
    screensaver_raw = assignments.get(
        "SCOREBOARD_SCREENSAVER_IDLE_SECONDS",
        os.environ.get(
            "SCOREBOARD_SCREENSAVER_IDLE_SECONDS",
            DISPLAY_IDLE_SETTING_DEFAULTS["SCOREBOARD_SCREENSAVER_IDLE_SECONDS"],
        ),
    )
    blackout_raw = assignments.get(
        "SCOREBOARD_BLACKOUT_IDLE_SECONDS",
        os.environ.get(
            "SCOREBOARD_BLACKOUT_IDLE_SECONDS",
            DISPLAY_IDLE_SETTING_DEFAULTS["SCOREBOARD_BLACKOUT_IDLE_SECONDS"],
        ),
    )

    try:
        screensaver_seconds = int(
            str(screensaver_raw).strip() or DISPLAY_IDLE_SETTING_DEFAULTS["SCOREBOARD_SCREENSAVER_IDLE_SECONDS"]
        )
    except ValueError:
        screensaver_seconds = int(DISPLAY_IDLE_SETTING_DEFAULTS["SCOREBOARD_SCREENSAVER_IDLE_SECONDS"])

    try:
        blackout_seconds = int(
            str(blackout_raw).strip() or DISPLAY_IDLE_SETTING_DEFAULTS["SCOREBOARD_BLACKOUT_IDLE_SECONDS"]
        )
    except ValueError:
        blackout_seconds = int(DISPLAY_IDLE_SETTING_DEFAULTS["SCOREBOARD_BLACKOUT_IDLE_SECONDS"])

    return {
        "env_file": env_path,
        "screensaver_idle_seconds": max(0, screensaver_seconds),
        "blackout_idle_seconds": max(0, blackout_seconds),
    }


def parse_wifi_settings_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Wi-Fi settings payload must be a JSON object.")

    fallback_mode = str(payload.get("fallback_mode", "")).strip().lower()

    if fallback_mode not in {"usb-only", "allow-fallback"}:
        raise ValueError("Fallback mode must be 'usb-only' or 'allow-fallback'.")

    grace_value = payload.get("primary_recovery_grace_seconds", 0)

    try:
        grace_seconds = int(grace_value)
    except (TypeError, ValueError):
        raise ValueError("Recovery grace must be a whole number of seconds.")

    if grace_seconds < 0:
        raise ValueError("Recovery grace cannot be negative.")

    if grace_seconds > 86400:
        raise ValueError("Recovery grace must be 86400 seconds or less.")

    return {
        "SCOREBOARD_WIFI_ALLOW_FALLBACK": "1" if fallback_mode == "allow-fallback" else "0",
        "SCOREBOARD_WIFI_PRIMARY_RECOVERY_GRACE_SECONDS": str(grace_seconds),
    }


def parse_display_idle_settings_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Display idle settings payload must be a JSON object.")

    try:
        screensaver_seconds = int(payload.get("screensaver_idle_seconds", 0))
        blackout_seconds = int(payload.get("blackout_idle_seconds", 0))
    except (TypeError, ValueError):
        raise ValueError("Display idle settings must be whole numbers of seconds.")

    if screensaver_seconds < 0 or blackout_seconds < 0:
        raise ValueError("Display idle settings cannot be negative.")

    if screensaver_seconds > 86400 or blackout_seconds > 86400:
        raise ValueError("Display idle settings must be 86400 seconds or less.")

    return {
        "SCOREBOARD_SCREENSAVER_IDLE_SECONDS": str(screensaver_seconds),
        "SCOREBOARD_BLACKOUT_IDLE_SECONDS": str(blackout_seconds),
    }


def write_env_settings(updates):
    env_path = resolve_env_file_path()
    os.makedirs(os.path.dirname(env_path), exist_ok=True)
    existing_lines = []

    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as handle:
            existing_lines = handle.readlines()

    rendered_lines = []
    written_keys = set()

    for raw_line in existing_lines:
        stripped = raw_line.strip()

        if not stripped or stripped.startswith("#") or "=" not in raw_line:
            rendered_lines.append(raw_line)
            continue

        key, _value = raw_line.split("=", 1)
        normalized_key = key.strip()

        if normalized_key not in updates:
            rendered_lines.append(raw_line)
            continue

        if normalized_key in written_keys:
            continue

        rendered_lines.append(f"{normalized_key}={updates[normalized_key]}\n")
        written_keys.add(normalized_key)

    for key, value in updates.items():
        if key not in written_keys:
            rendered_lines.append(f"{key}={value}\n")

    temp_path = env_path + ".tmp"

    with open(temp_path, "w", encoding="utf-8") as handle:
        handle.writelines(rendered_lines)

    os.replace(temp_path, env_path)

    for key, value in updates.items():
        os.environ[key] = value

    return env_path


def resolve_system_command(action_name):
    if os.name != "posix":
        raise RuntimeError("System actions are only supported on the Raspberry Pi host.")

    action = SYSTEM_ACTIONS[action_name]
    base_command = action["command"]
    executable = shutil.which(base_command[0])

    if not executable:
        raise RuntimeError(f"{base_command[0]} is not available on this host.")

    command = [executable, *base_command[1:]]

    geteuid = getattr(os, "geteuid", None)

    if callable(geteuid) and geteuid() == 0:
        return command

    sudo = shutil.which("sudo")

    if not sudo:
        raise RuntimeError("sudo is not available for web system actions on this host.")

    permission_check = subprocess.run(
        [sudo, "-n", "-l", *command],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )

    if permission_check.returncode != 0:
        raise RuntimeError(
            "The web controller is not allowed to run system actions. Re-run scripts/install.sh on the Pi to refresh the sudoers rule."
        )

    return [sudo, "-n", *command]


def run_system_command_async(action_name):
    command = resolve_system_command(action_name)
    action = SYSTEM_ACTIONS[action_name]

    def launch():
        try:
            LOGGER.info("Running system action %s: %s", action_name, " ".join(command))
            subprocess.run(command, check=True, start_new_session=True)
        except Exception:
            LOGGER.exception("System action %s failed", action_name)

    timer = threading.Timer(0.25, launch)
    timer.daemon = True
    timer.start()

    return {
        "ok": True,
        "action": action_name,
        "message": action["message"],
    }


def handle_socket_message(raw_message):
    try:
        payload = json.loads(raw_message or "{}")
    except json.JSONDecodeError:
        return error_message("Invalid JSON websocket message.")

    if not isinstance(payload, dict):
        return error_message("Websocket messages must be JSON objects.")

    request_id = payload.get("request_id")
    message_type = payload.get("type") or "hello"

    if message_type in {"hello", "get_state"}:
        return state_message(read_state(), request_id=request_id)

    if message_type == "update_state":
        if not control_key_is_valid(payload.get("control_key", "")):
            return error_message("Unauthorized. Provide a valid control key.", status=401, request_id=request_id)

        try:
            next_patch = parse_state_patch(payload.get("state"))
        except ValueError as error:
            return error_message(str(error), status=400, request_id=request_id)

        saved = write_state(merge_state(read_state(), next_patch))
        broadcast_state(saved, request_id=request_id)
        return None

    if message_type == "perform_action":
        if not control_key_is_valid(payload.get("control_key", "")):
            return error_message("Unauthorized. Provide a valid control key.", status=401, request_id=request_id)

        try:
            action_name = parse_action_name(payload.get("action"))
            saved = write_state(apply_action(read_state(), action_name))
        except ValueError as error:
            return error_message(str(error), status=400, request_id=request_id)

        broadcast_state(saved, request_id=request_id)
        return None

    if message_type == "reset_state":
        if not control_key_is_valid(payload.get("control_key", "")):
            return error_message("Unauthorized. Provide a valid control key.", status=401, request_id=request_id)

        saved = write_state(build_reset_state(read_state()))
        broadcast_state(saved, request_id=request_id)
        return None

    return error_message("Unsupported websocket message type.", status=400, request_id=request_id)


@app.get("/")
def root():
    return redirect("/display")


@app.get("/display")
def display():
    current_state = read_state()
    active_design = get_scoreboard_design(current_state.get("design_id"))
    display_idle_settings = read_display_idle_settings()
    return render_template(
        "display.html",
        school_name=SCHOOL_NAME,
        scoreboard_designs=list_scoreboard_designs(),
        default_design_id=DEFAULT_SCOREBOARD_DESIGN_ID,
        active_design=active_design,
        display_template=active_design["template"],
        initial_state=with_derived(current_state, default_source=MODE_NAME),
        screensaver_idle_seconds=display_idle_settings["screensaver_idle_seconds"],
        blackout_idle_seconds=display_idle_settings["blackout_idle_seconds"],
    )


@app.get("/control")
def control():
    current_state = read_state()
    return render_template(
        "control.html",
        school_name=SCHOOL_NAME,
        require_key=bool(read_control_key()),
        scoreboard_designs=list_scoreboard_designs(),
        default_design_id=DEFAULT_SCOREBOARD_DESIGN_ID,
        initial_state=with_derived(current_state, default_source=MODE_NAME),
    )


@app.get("/favicon.ico")
def favicon():
    return send_from_directory(BASE_DIR, "favicon.ico", mimetype="image/x-icon")


@app.get("/public/<path:filename>")
def public_asset(filename):
    return send_from_directory(os.path.join(app.root_path, "public"), filename)


@app.get("/health")
def health():
    return jsonify({"ok": True, "websocket_clients": len(WS_CLIENTS), "mode": MODE_NAME})


@app.get("/api/state")
def get_state():
    return jsonify(api_payload(read_state()))


@app.post("/api/state")
def update_state():
    auth_error = require_control_key()

    if auth_error:
        return auth_error

    payload = request.get_json(silent=True) or {}

    if not isinstance(payload, dict):
        return jsonify(error_message("State payload must be a JSON object.")), 400

    saved = write_state(merge_state(read_state(), payload))
    broadcast_state(saved)
    return jsonify(api_payload(saved))


@app.post("/api/action")
def action_api():
    auth_error = require_control_key()

    if auth_error:
        return auth_error

    payload = request.get_json(silent=True) or {}

    if not isinstance(payload, dict):
        return jsonify(error_message("Action payload must be a JSON object.")), 400

    try:
        action_name = parse_action_name(payload.get("action"))
        saved = write_state(apply_action(read_state(), action_name))
    except ValueError as error:
        return jsonify(error_message(str(error))), 400

    broadcast_state(saved)
    return jsonify(api_payload(saved))


@app.post("/api/reset")
def reset_api():
    auth_error = require_control_key()

    if auth_error:
        return auth_error

    saved = write_state(build_reset_state(read_state()))
    broadcast_state(saved)
    return jsonify(api_payload(saved))


@app.post("/api/system")
def system_api():
    auth_error = require_control_key()

    if auth_error:
        return auth_error

    payload = request.get_json(silent=True) or {}

    if not isinstance(payload, dict):
        return jsonify(error_message("System action payload must be a JSON object.")), 400

    try:
        action_name = parse_system_action(payload.get("action"))
        accepted = run_system_command_async(action_name)
    except ValueError as error:
        return jsonify(error_message(str(error))), 400
    except RuntimeError as error:
        return jsonify(error_message(str(error), status=503)), 503

    return jsonify(accepted)


@app.get("/api/settings/wifi")
def wifi_settings_api():
    auth_error = require_control_key()

    if auth_error:
        return auth_error

    settings = read_wifi_settings()
    return jsonify(
        {
            "ok": True,
            "fallback_mode": "allow-fallback" if settings["allow_fallback"] else "usb-only",
            "allow_fallback": settings["allow_fallback"],
            "primary_recovery_grace_seconds": settings["primary_recovery_grace_seconds"],
        }
    )


@app.post("/api/settings/wifi")
def update_wifi_settings_api():
    auth_error = require_control_key()

    if auth_error:
        return auth_error

    payload = request.get_json(silent=True) or {}

    try:
        updates = parse_wifi_settings_payload(payload)
        env_path = write_env_settings(updates)
        settings = read_wifi_settings()
    except ValueError as error:
        return jsonify(error_message(str(error))), 400
    except OSError as error:
        return jsonify(error_message(f"Unable to save Wi-Fi settings: {error}", status=500)), 500

    return jsonify(
        {
            "ok": True,
            "message": "Wi-Fi failover settings saved. The maintenance timer will pick them up on its next run.",
            "env_file": env_path,
            "fallback_mode": "allow-fallback" if settings["allow_fallback"] else "usb-only",
            "allow_fallback": settings["allow_fallback"],
            "primary_recovery_grace_seconds": settings["primary_recovery_grace_seconds"],
        }
    )


@app.get("/api/settings/display-idle")
def display_idle_settings_api():
    auth_error = require_control_key()

    if auth_error:
        return auth_error

    settings = read_display_idle_settings()
    return jsonify(
        {
            "ok": True,
            "screensaver_idle_seconds": settings["screensaver_idle_seconds"],
            "blackout_idle_seconds": settings["blackout_idle_seconds"],
        }
    )


@app.post("/api/settings/display-idle")
def update_display_idle_settings_api():
    auth_error = require_control_key()

    if auth_error:
        return auth_error

    payload = request.get_json(silent=True) or {}

    try:
        updates = parse_display_idle_settings_payload(payload)
        env_path = write_env_settings(updates)
        settings = read_display_idle_settings()
    except ValueError as error:
        return jsonify(error_message(str(error))), 400
    except OSError as error:
        return jsonify(error_message(f"Unable to save display idle settings: {error}", status=500)), 500

    broadcast_state(read_state())

    return jsonify(
        {
            "ok": True,
            "message": "Display idle settings saved.",
            "env_file": env_path,
            "screensaver_idle_seconds": settings["screensaver_idle_seconds"],
            "blackout_idle_seconds": settings["blackout_idle_seconds"],
        }
    )


@sock.route("/ws")
def scoreboard_socket(ws):
    register_client(ws)

    try:
        safe_send(ws, state_message(read_state()))

        while True:
            raw_message = ws.receive()

            if raw_message is None:
                break

            response = handle_socket_message(raw_message)

            if response is not None:
                safe_send(ws, response)
    except ConnectionClosed:
        pass
    finally:
        unregister_client(ws)


if __name__ == "__main__":
    app.run(host=SCOREBOARD_HOST, port=SCOREBOARD_PORT, threaded=True)
