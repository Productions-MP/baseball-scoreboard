import json
import os
import threading
from copy import deepcopy
from datetime import datetime, timezone

from flask import Flask, jsonify, redirect, render_template, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.environ.get("FALLBACK_STATE_FILE", os.path.join(BASE_DIR, "fallback_state.json"))
FALLBACK_HOST = os.environ.get("FALLBACK_HOST", "0.0.0.0")
FALLBACK_PORT = int(os.environ.get("FALLBACK_PORT", "5050"))
FALLBACK_CONTROL_KEY = os.environ.get("FALLBACK_CONTROL_KEY", "").strip()
SCHOOL_NAME = os.environ.get("SCHOOL_NAME", "Highlands Latin School")

STATE_LOCK = threading.Lock()

DEFAULT_STATE = {
    "inning": 1,
    "half": "top",
    "balls": 0,
    "strikes": 0,
    "outs": 0,
    "guest_runs": [0] * 10,
    "home_runs": [0] * 10,
}

app = Flask(__name__)


def clone_default_state():
    return deepcopy(DEFAULT_STATE)


def to_int(value, fallback=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def clamp(value, minimum, maximum):
    return min(maximum, max(minimum, value))


def normalize_runs(value):
    runs = value if isinstance(value, list) else []
    normalized = []

    for index in range(10):
        run_value = runs[index] if index < len(runs) else 0
        normalized.append(max(0, to_int(run_value, 0)))

    return normalized


def normalize_state(data=None):
    source = data or {}
    return {
        "inning": clamp(to_int(source.get("inning"), 1), 1, 10),
        "half": "bottom" if source.get("half") == "bottom" else "top",
        "balls": clamp(to_int(source.get("balls"), 0), 0, 3),
        "strikes": clamp(to_int(source.get("strikes"), 0), 0, 2),
        "outs": clamp(to_int(source.get("outs"), 0), 0, 2),
        "guest_runs": normalize_runs(source.get("guest_runs")),
        "home_runs": normalize_runs(source.get("home_runs")),
    }


def with_derived(state):
    normalized = normalize_state(state)
    return {
        **normalized,
        "guest_total": sum(normalized["guest_runs"]),
        "home_total": sum(normalized["home_runs"]),
        "updated_at": state.get("updated_at") if isinstance(state, dict) else None,
        "source": state.get("source") if isinstance(state, dict) else "fallback",
    }


def stamp_state(state):
    return {
        **normalize_state(state),
        "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "fallback",
    }


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
        "source": data.get("source", "fallback"),
    }


def write_state(next_state):
    stamped = stamp_state(next_state)

    with STATE_LOCK:
        atomic_write_state(stamped)

    return stamped


def require_control_key():
    if not FALLBACK_CONTROL_KEY:
        return None

    provided = request.headers.get("x-scoreboard-key", "").strip()

    if not provided or provided != FALLBACK_CONTROL_KEY:
        return jsonify({"ok": False, "error": "Unauthorized. Provide a valid fallback control key."}), 401

    return None


def api_payload(state):
    return {
        "ok": True,
        "mode": "fallback",
        "updated_at": state.get("updated_at"),
        "state": with_derived(state),
    }


@app.get("/")
def root():
    return redirect("/display")


@app.get("/display")
def display():
    return render_template("display.html", school_name=SCHOOL_NAME)


@app.get("/control")
def control():
    return render_template(
        "control.html",
        school_name=SCHOOL_NAME,
        require_key=bool(FALLBACK_CONTROL_KEY),
    )


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.get("/api/state")
def get_state():
    return jsonify(api_payload(read_state()))


@app.post("/api/state")
def update_state():
    auth_error = require_control_key()

    if auth_error:
        return auth_error

    payload = request.get_json(silent=True) or {}
    current = read_state()

    merged = {
        **current,
        **payload,
        "guest_runs": payload.get("guest_runs", current.get("guest_runs")),
        "home_runs": payload.get("home_runs", current.get("home_runs")),
    }

    saved = write_state(merged)
    return jsonify(api_payload(saved))


@app.post("/api/reset")
def reset_api():
    auth_error = require_control_key()

    if auth_error:
        return auth_error

    saved = write_state(clone_default_state())
    return jsonify(api_payload(saved))


if __name__ == "__main__":
    app.run(host=FALLBACK_HOST, port=FALLBACK_PORT)
