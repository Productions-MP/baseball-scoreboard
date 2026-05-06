from copy import deepcopy


SPORT_ID = "baseball"
SPORT_LABEL = "Baseball"
DEFAULT_TEMPLATE_ID = "baseball-linescore-v2"

TEMPLATES = (
    {
        "id": "baseball-linescore-v1",
        "sport_id": SPORT_ID,
        "label": "Linescore v1",
        "width": 768,
        "height": 192,
        "template": "display_partials/baseball_v1.html",
        "renderer": "baseball-linescore-v1",
    },
    {
        "id": "baseball-linescore-v2",
        "sport_id": SPORT_ID,
        "label": "Linescore v2",
        "width": 768,
        "height": 192,
        "template": "display_partials/baseball_v2.html",
        "renderer": "baseball-linescore-v2",
    },
)

DEFAULT_GAME = {
    "inning": 1,
    "half": "top",
    "ball": 0,
    "strike": 0,
    "out": 0,
    "guest_runs": [0] * 10,
    "home_runs": [0] * 10,
}


def default_game():
    return deepcopy(DEFAULT_GAME)


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


def normalize_game(data=None):
    source = data or {}
    return {
        "inning": clamp(to_int(source.get("inning"), 1), 1, 10),
        "half": "bottom" if source.get("half") == "bottom" else "top",
        "ball": clamp(to_int(source.get("ball", source.get("balls")), 0), 0, 3),
        "strike": clamp(to_int(source.get("strike", source.get("strikes")), 0), 0, 2),
        "out": clamp(to_int(source.get("out", source.get("outs")), 0), 0, 2),
        "guest_runs": normalize_runs(source.get("guest_runs")),
        "home_runs": normalize_runs(source.get("home_runs")),
    }


def with_derived(game):
    normalized = normalize_game(game)
    return {
        **normalized,
        "guest_total": sum(normalized["guest_runs"]),
        "home_total": sum(normalized["home_runs"]),
    }


def clear_ball_strikes(target_game):
    target_game["ball"] = 0
    target_game["strike"] = 0


def clear_count(target_game):
    clear_ball_strikes(target_game)
    target_game["out"] = 0


def next_half(target_game):
    if target_game["half"] == "top":
        target_game["half"] = "bottom"
    else:
        target_game["half"] = "top"
        target_game["inning"] = min(10, target_game["inning"] + 1)

    clear_count(target_game)


def record_out(target_game):
    if target_game["out"] >= 2:
        next_half(target_game)
        return

    target_game["out"] += 1
    clear_ball_strikes(target_game)


def current_inning_index(game):
    return max(0, min(9, game["inning"] - 1))


def current_batting_team_key(game):
    return "home_runs" if game["half"] == "bottom" else "guest_runs"


def adjust_current_batting_runs(target_game, delta):
    inning_index = current_inning_index(target_game)
    team_key = current_batting_team_key(target_game)
    target_game[team_key][inning_index] = max(0, target_game[team_key][inning_index] + delta)


def apply_action(game, action, payload=None):
    action_name = str(action or "").strip()

    if not action_name:
        raise ValueError("Action name is required.")

    next_game = normalize_game(game)

    if action_name == "inning-down":
        next_game["inning"] = max(1, next_game["inning"] - 1)
    elif action_name == "inning-up":
        next_game["inning"] = min(10, next_game["inning"] + 1)
    elif action_name == "set-guest-at-bat":
        next_game["half"] = "top"
    elif action_name == "set-home-at-bat":
        next_game["half"] = "bottom"
    elif action_name == "next-half":
        next_half(next_game)
    elif action_name == "ball-down":
        next_game["ball"] = max(0, next_game["ball"] - 1)
    elif action_name == "ball-up":
        if next_game["ball"] >= 3:
            clear_ball_strikes(next_game)
        else:
            next_game["ball"] += 1
    elif action_name == "strike-down":
        next_game["strike"] = max(0, next_game["strike"] - 1)
    elif action_name == "strike-up":
        if next_game["strike"] >= 2:
            record_out(next_game)
        else:
            next_game["strike"] += 1
    elif action_name == "out-down":
        next_game["out"] = max(0, next_game["out"] - 1)
    elif action_name == "out-up":
        record_out(next_game)
    elif action_name == "current-runs-down":
        adjust_current_batting_runs(next_game, -1)
    elif action_name == "current-runs-up":
        adjust_current_batting_runs(next_game, 1)
    elif action_name == "clear-ball-strikes":
        clear_ball_strikes(next_game)
    else:
        raise ValueError(f"Unsupported baseball action '{action_name}'.")

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
