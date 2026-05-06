from copy import deepcopy

from shared.scorehls_registry import (
    DEFAULT_SPORT_ID,
    get_sport,
    get_template,
    normalize_sport_id,
    normalize_template_id,
)


SCHEMA_VERSION = 1

DEFAULT_TEAM_NAME_GUEST = "Guest"
DEFAULT_TEAM_NAME_HOME = "Home"
DEFAULT_PERIOD_SECONDS = 12 * 60
TEAM_NAME_MAX_LENGTH = 16


def to_bool(value, fallback=False):
    if value is None:
        return fallback

    if isinstance(value, bool):
        return value

    if isinstance(value, str):
        candidate = value.strip().lower()

        if candidate in {"1", "true", "yes", "on"}:
            return True

        if candidate in {"0", "false", "no", "off"}:
            return False

        return fallback

    if isinstance(value, (int, float)):
        return bool(value)

    return fallback


def normalize_team_name(value, fallback):
    candidate = ""

    if isinstance(value, str):
        candidate = value.strip()

    if not candidate:
        return fallback

    return candidate[:TEAM_NAME_MAX_LENGTH]


def normalize_period_seconds(value):
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        seconds = DEFAULT_PERIOD_SECONDS

    return max(60, min(99 * 60, seconds))


def default_settings():
    return {
        "guest_team_name": DEFAULT_TEAM_NAME_GUEST,
        "home_team_name": DEFAULT_TEAM_NAME_HOME,
        "period_seconds": DEFAULT_PERIOD_SECONDS,
    }


def normalize_settings(data=None):
    source = data if isinstance(data, dict) else {}
    return {
        "guest_team_name": normalize_team_name(source.get("guest_team_name"), DEFAULT_TEAM_NAME_GUEST),
        "home_team_name": normalize_team_name(source.get("home_team_name"), DEFAULT_TEAM_NAME_HOME),
        "period_seconds": normalize_period_seconds(source.get("period_seconds")),
    }


def clone_default_state(sport_id=None):
    sport = get_sport(sport_id)
    return normalize_state(
        {
            "schema_version": SCHEMA_VERSION,
            "sport_id": sport["id"],
            "template_id": sport["default_template_id"],
            "blackout": False,
            "game": sport["default_game"](),
            "settings": default_settings(),
        }
    )


def normalize_state(data=None):
    source = data if isinstance(data, dict) else {}
    sport_id = normalize_sport_id(source.get("sport_id"))
    sport = get_sport(sport_id)
    raw_game = source.get("game")

    if not isinstance(raw_game, dict):
        raw_game = sport["default_game"]()

    return {
        "schema_version": SCHEMA_VERSION,
        "sport_id": sport["id"],
        "template_id": normalize_template_id(source.get("template_id"), sport["id"]),
        "blackout": to_bool(source.get("blackout"), False),
        "game": sport["normalize_game"](deepcopy(raw_game)),
        "settings": normalize_settings(source.get("settings")),
    }


def build_reset_state(current_state=None):
    if not isinstance(current_state, dict):
        return clone_default_state()

    sport_id = normalize_sport_id(current_state.get("sport_id"))
    sport = get_sport(sport_id)
    settings = normalize_settings(current_state.get("settings"))
    game = sport["default_game"]()

    if sport_id == "football":
        game["clock_seconds"] = settings["period_seconds"]

    return normalize_state(
        {
            "sport_id": sport["id"],
            "template_id": normalize_template_id(current_state.get("template_id"), sport["id"]),
            "blackout": to_bool(current_state.get("blackout"), False),
            "game": game,
            "settings": settings,
        }
    )


def merge_state(current_state, patch=None):
    state_patch = patch if isinstance(patch, dict) else {}
    normalized_current = normalize_state(current_state)
    next_sport_id = normalize_sport_id(state_patch.get("sport_id", normalized_current["sport_id"]))
    sport_changed = next_sport_id != normalized_current["sport_id"]
    sport = get_sport(next_sport_id)
    next_settings = normalize_settings(state_patch.get("settings", normalized_current["settings"]))

    if sport_changed:
        next_game = sport["default_game"]()

        if next_sport_id == "football":
            next_game["clock_seconds"] = next_settings["period_seconds"]

        next_template_id = state_patch.get("template_id", sport["default_template_id"])
    else:
        next_game = state_patch.get("game", normalized_current["game"])
        next_template_id = state_patch.get("template_id", normalized_current["template_id"])

    return normalize_state(
        {
            **normalized_current,
            **state_patch,
            "sport_id": next_sport_id,
            "template_id": next_template_id,
            "game": next_game,
            "settings": next_settings,
        }
    )


def apply_action(state, action, payload=None):
    normalized = normalize_state(state)
    sport = get_sport(normalized["sport_id"])
    normalized["game"] = sport["apply_action"](normalized["game"], action, payload=payload)
    return normalize_state(normalized)


def with_derived(state, default_source="scorehls"):
    normalized = normalize_state(state)
    sport = get_sport(normalized["sport_id"])
    template = get_template(normalized["template_id"], normalized["sport_id"])
    derived_game = sport["with_derived"](normalized["game"])

    return {
        **normalized,
        **derived_game,
        "game": derived_game,
        "sport": {
            "id": sport["id"],
            "label": sport["label"],
            "default_template_id": sport["default_template_id"],
        },
        "template": template,
        "updated_at": state.get("updated_at") if isinstance(state, dict) else None,
        "source": state.get("source") if isinstance(state, dict) else default_source,
    }
