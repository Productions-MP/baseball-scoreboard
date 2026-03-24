DEFAULT_SCOREBOARD_DESIGN_ID = "baseball-v1"

SCOREBOARD_DESIGNS = (
    {
        "id": "baseball-v1",
        "label": "Baseball v1",
        "width": 768,
        "height": 192,
        "template": "display_partials/baseball_v1.html",
    },
    {
        "id": "baseball-v2",
        "label": "Baseball v2",
        "width": 768,
        "height": 192,
        "template": "display_partials/baseball_v2.html",
    },
)

_SCOREBOARD_DESIGNS_BY_ID = {design["id"]: design for design in SCOREBOARD_DESIGNS}


def normalize_design_id(design_id):
    candidate = str(design_id or "").strip()

    if candidate in _SCOREBOARD_DESIGNS_BY_ID:
        return candidate

    return DEFAULT_SCOREBOARD_DESIGN_ID


def get_scoreboard_design(design_id=None):
    return dict(_SCOREBOARD_DESIGNS_BY_ID[normalize_design_id(design_id)])


def list_scoreboard_designs():
    return [dict(design) for design in SCOREBOARD_DESIGNS]
