from copy import deepcopy

from shared.scoreboard_designs import DEFAULT_SCOREBOARD_DESIGN_ID, get_scoreboard_design, normalize_design_id

DEFAULT_STATE = {
    "design_id": DEFAULT_SCOREBOARD_DESIGN_ID,
    "inning": 1,
    "half": "top",
    "ball": 0,
    "strike": 0,
    "out": 0,
    "guest_runs": [0] * 10,
    "home_runs": [0] * 10,
}


def clone_default_state():
    return deepcopy(DEFAULT_STATE)


def build_reset_state(current_state=None):
    reset_state = clone_default_state()

    if isinstance(current_state, dict):
        reset_state["design_id"] = normalize_design_id(
            current_state.get("design_id", current_state.get("scoreboard_design_id"))
        )

    return normalize_state(reset_state)


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
        "design_id": normalize_design_id(source.get("design_id", source.get("scoreboard_design_id"))),
        "inning": clamp(to_int(source.get("inning"), 1), 1, 10),
        "half": "bottom" if source.get("half") == "bottom" else "top",
        "ball": clamp(to_int(source.get("ball", source.get("balls")), 0), 0, 3),
        "strike": clamp(to_int(source.get("strike", source.get("strikes")), 0), 0, 2),
        "out": clamp(to_int(source.get("out", source.get("outs")), 0), 0, 2),
        "guest_runs": normalize_runs(source.get("guest_runs")),
        "home_runs": normalize_runs(source.get("home_runs")),
    }


def merge_state(current_state, patch=None):
    state_patch = patch if isinstance(patch, dict) else {}
    return normalize_state(
        {
            **current_state,
            **state_patch,
            "guest_runs": state_patch.get("guest_runs", current_state.get("guest_runs")),
            "home_runs": state_patch.get("home_runs", current_state.get("home_runs")),
        }
    )


def with_derived(state, default_source="scoreboard"):
    normalized = normalize_state(state)
    return {
        **normalized,
        "design": get_scoreboard_design(normalized["design_id"]),
        "guest_total": sum(normalized["guest_runs"]),
        "home_total": sum(normalized["home_runs"]),
        "updated_at": state.get("updated_at") if isinstance(state, dict) else None,
        "source": state.get("source") if isinstance(state, dict) else default_source,
    }


def clear_ball_strikes(target_state):
    target_state["ball"] = 0
    target_state["strike"] = 0


def clear_count(target_state):
    clear_ball_strikes(target_state)
    target_state["out"] = 0


def next_half(target_state):
    if target_state["half"] == "top":
        target_state["half"] = "bottom"
    else:
        target_state["half"] = "top"
        target_state["inning"] = min(10, target_state["inning"] + 1)

    clear_count(target_state)


def record_out(target_state):
    if target_state["out"] >= 2:
        next_half(target_state)
        return

    target_state["out"] += 1
    clear_ball_strikes(target_state)


def current_inning_index(state):
    return max(0, min(9, state["inning"] - 1))


def current_batting_team_key(state):
    return "home_runs" if state["half"] == "bottom" else "guest_runs"


def adjust_current_batting_runs(target_state, delta):
    inning_index = current_inning_index(target_state)
    team_key = current_batting_team_key(target_state)
    target_state[team_key][inning_index] = max(0, target_state[team_key][inning_index] + delta)


def apply_action(state, action):
    action_name = str(action or "").strip()

    if not action_name:
        raise ValueError("Action name is required.")

    next_state = normalize_state(state)

    if action_name == "inning-down":
        next_state["inning"] = max(1, next_state["inning"] - 1)
    elif action_name == "inning-up":
        next_state["inning"] = min(10, next_state["inning"] + 1)
    elif action_name == "set-guest-at-bat":
        next_state["half"] = "top"
    elif action_name == "set-home-at-bat":
        next_state["half"] = "bottom"
    elif action_name == "next-half":
        next_half(next_state)
    elif action_name == "ball-down":
        next_state["ball"] = max(0, next_state["ball"] - 1)
    elif action_name == "ball-up":
        if next_state["ball"] >= 3:
            clear_ball_strikes(next_state)
        else:
            next_state["ball"] += 1
    elif action_name == "strike-down":
        next_state["strike"] = max(0, next_state["strike"] - 1)
    elif action_name == "strike-up":
        if next_state["strike"] >= 2:
            record_out(next_state)
        else:
            next_state["strike"] += 1
    elif action_name == "out-down":
        next_state["out"] = max(0, next_state["out"] - 1)
    elif action_name == "out-up":
        record_out(next_state)
    elif action_name == "current-runs-down":
        adjust_current_batting_runs(next_state, -1)
    elif action_name == "current-runs-up":
        adjust_current_batting_runs(next_state, 1)
    elif action_name == "clear-ball-strikes":
        clear_ball_strikes(next_state)
    else:
        raise ValueError(f"Unsupported action '{action_name}'.")

    return normalize_state(next_state)
