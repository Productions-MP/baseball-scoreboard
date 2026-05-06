from copy import deepcopy


SPORT_ID = "football"
SPORT_LABEL = "Football"
DEFAULT_TEMPLATE_ID = "football-clock-v1"
QUARTER_DEFAULT_SECONDS = 12 * 60

TEMPLATES = (
    {
        "id": "football-clock-v1",
        "sport_id": SPORT_ID,
        "label": "Clock v1",
        "width": 768,
        "height": 192,
        "template": "display_partials/football_v1.html",
        "renderer": "football-clock-v1",
    },
)

DEFAULT_GAME = {
    "quarter": 1,
    "clock_seconds": QUARTER_DEFAULT_SECONDS,
    "clock_running": False,
    "clock_updated_at": None,
    "guest_score": 0,
    "home_score": 0,
}


def default_game():
    return deepcopy(DEFAULT_GAME)


def to_int(value, fallback=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def to_bool(value, fallback=False):
    if isinstance(value, bool):
        return value

    if isinstance(value, (int, float)):
        return bool(value)

    if isinstance(value, str):
        candidate = value.strip().lower()

        if candidate in {"1", "true", "yes", "on"}:
            return True

        if candidate in {"0", "false", "no", "off", ""}:
            return False

    return fallback


def clamp(value, minimum, maximum):
    return min(maximum, max(minimum, value))


def normalize_clock_seconds(value):
    return max(0, to_int(value, 0))


def normalize_clock_updated_at(value):
    if not isinstance(value, str):
        return None

    text = value.strip()
    return text or None


def normalize_game(data=None):
    source = data or {}
    return {
        "quarter": clamp(to_int(source.get("quarter"), 1), 1, 4),
        "clock_seconds": normalize_clock_seconds(source.get("clock_seconds")),
        "clock_running": to_bool(source.get("clock_running"), False),
        "clock_updated_at": normalize_clock_updated_at(source.get("clock_updated_at")),
        "guest_score": max(0, to_int(source.get("guest_score"), 0)),
        "home_score": max(0, to_int(source.get("home_score"), 0)),
    }


def with_derived(game):
    return normalize_game(game)


def apply_action(game, action, payload=None):
    action_name = str(action or "").strip()

    if not action_name:
        raise ValueError("Action name is required.")

    next_game = normalize_game(game)
    payload_dict = payload if isinstance(payload, dict) else {}

    if action_name == "quarter-up":
        next_game["quarter"] = min(4, next_game["quarter"] + 1)
    elif action_name == "quarter-down":
        next_game["quarter"] = max(1, next_game["quarter"] - 1)
    elif action_name == "clock-set":
        seconds = normalize_clock_seconds(payload_dict.get("seconds"))
        next_game["clock_seconds"] = seconds
        next_game["clock_running"] = False
        next_game["clock_updated_at"] = None
    elif action_name == "clock-reset-quarter":
        next_game["clock_seconds"] = QUARTER_DEFAULT_SECONDS
        next_game["clock_running"] = False
        next_game["clock_updated_at"] = None
    elif action_name == "guest-score-add":
        delta = to_int(payload_dict.get("delta"), 0)
        next_game["guest_score"] = max(0, next_game["guest_score"] + delta)
    elif action_name == "home-score-add":
        delta = to_int(payload_dict.get("delta"), 0)
        next_game["home_score"] = max(0, next_game["home_score"] + delta)
    else:
        raise ValueError("Unsupported football action '" + action_name + "'.")

    return normalize_game(next_game)


SPORT = {
    "id": SPORT_ID,
    "label": SPORT_LABEL,
    "default_template_id": DEFAULT_TEMPLATE_ID,
    "templates": TEMPLATES,
    "default_game": default_game,
    "normalize_game": normalize_game,
    "apply_action": apply_action,
    "with_derived": with_derived,
}
