from shared.sports import baseball, football


SPORTS = (baseball.SPORT, football.SPORT)
DEFAULT_SPORT_ID = baseball.SPORT_ID

_SPORTS_BY_ID = {sport["id"]: sport for sport in SPORTS}
_TEMPLATES_BY_ID = {
    template["id"]: template
    for sport in SPORTS
    for template in sport["templates"]
}


def normalize_sport_id(sport_id):
    candidate = str(sport_id or "").strip()

    if candidate in _SPORTS_BY_ID:
        return candidate

    return DEFAULT_SPORT_ID


def get_sport(sport_id=None):
    return _SPORTS_BY_ID[normalize_sport_id(sport_id)]


def list_sports():
    return [
        {
            "id": sport["id"],
            "label": sport["label"],
            "default_template_id": sport["default_template_id"],
            "templates": [dict(template) for template in sport["templates"]],
        }
        for sport in SPORTS
    ]


def list_templates(sport_id=None):
    sport = get_sport(sport_id)
    return [dict(template) for template in sport["templates"]]


def normalize_template_id(template_id, sport_id=None):
    sport = get_sport(sport_id)
    candidate = str(template_id or "").strip()

    if candidate in {template["id"] for template in sport["templates"]}:
        return candidate

    return sport["default_template_id"]


def get_template(template_id=None, sport_id=None):
    sport = get_sport(sport_id)
    normalized_template_id = normalize_template_id(template_id, sport["id"])
    return dict(_TEMPLATES_BY_ID[normalized_template_id])
