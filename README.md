# Highlands Latin Baseball Scoreboard

Local-only baseball scoreboard software for a Raspberry Pi Zero.

The Pi hosts everything:

- the display page at `/display`
- the control page at `/control`
- the JSON API at `/api/*`
- a websocket at `/ws` for live, low-latency state sync

The intended setup is:

1. Raspberry Pi runs the Flask app on the local network.
2. Chromium on the Pi opens the display in kiosk mode.
3. The control iPad joins the same network and opens the control page directly from the Pi.
4. State changes are persisted locally and pushed immediately to all connected clients over websocket.

## Project structure

```text
.
|-- .env.example
|-- .gitignore
|-- README.md
|-- app.py
|-- requirements.txt
|-- scripts/
|   |-- install.sh
|   |-- kiosk.sh
|   `-- open-local.sh
|-- services/
|   `-- scoreboard-local.service
|-- shared/
|   `-- default-state.json
|-- static/
|   |-- app.js
|   |-- control.js
|   |-- display.js
|   `-- style.css
`-- templates/
    |-- control.html
    `-- display.html
```

## Architecture

### HTTP endpoints

- `GET /display`
- `GET /control`
- `GET /api/state`
- `POST /api/state`
- `POST /api/reset`
- `GET /health`

### Websocket endpoint

- `GET /ws`

The websocket is the primary live transport now.

- Display pages subscribe and redraw instantly when state changes.
- Control pages send updates over websocket when available.
- HTTP writes remain as a fallback path if the socket is reconnecting.

### Local persistence

By default, runtime state is written to:

```text
runtime/scoreboard_state.json
```

That path is ignored by git so normal game operation does not dirty the repo.

## Shared state model

```json
{
  "inning": 1,
  "half": "top",
  "ball": 0,
  "strike": 0,
  "out": 0,
  "guest_runs": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "home_runs": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
}
```

Derived values are calculated server-side and client-side:

- `guest_total = sum(guest_runs)`
- `home_total = sum(home_runs)`

Validation rules:

- `inning`: `1` through `10`
- `half`: `top` or `bottom`
- `ball`: `0` through `3`
- `strike`: `0` through `2`
- `out`: `0` through `2`
- inning run values: non-negative integers

## Raspberry Pi setup

These steps assume Raspberry Pi OS with desktop, Chromium, and LAN or Wi-Fi already working.

1. Clone the repo onto the Pi, for example to `/home/pi/baseball-scoreboard`.
2. Copy [`.env.example`](.env.example) to `.env`.
3. Run:

```bash
cd ~/baseball-scoreboard/scripts
./install.sh
```

The installer will:

- create a Python virtual environment
- install Flask and websocket support
- create or normalize `.env`
- install and start `scoreboard-local.service`
- configure LXDE autostart to open the local display on boot
- create desktop launchers for the local display and local control

## Manual setup

```bash
cd ~/baseball-scoreboard
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python app.py
```

`app.py` reads `.env` automatically when it exists. It also accepts legacy `pi.env` and `pi-fallback/pi.env` files so older Pi installs keep working while you flatten the repo.

## Configuration

Example values live in [`.env.example`](.env.example).

Supported local variables:

- `SCOREBOARD_DISPLAY_URL`
- `SCOREBOARD_CONTROL_URL`
- `SCOREBOARD_HOST`
- `SCOREBOARD_PORT`
- `SCOREBOARD_CONTROL_KEY`
- `SCHOOL_NAME`
- `SCOREBOARD_STATE_FILE`

Legacy `FALLBACK_*` environment names are still accepted by the Python app so old Pi installs do not break immediately, but the local-only names above are now the primary interface.

## Daily operation

### Pi display

The kiosk display URL is:

```text
http://127.0.0.1:5050/display
```

You can relaunch it with:

```bash
~/baseball-scoreboard/scripts/open-local.sh
```

### iPad control

Find the Pi IP address:

```bash
hostname -I
```

Then open this on the iPad while it is on the same network:

```text
http://<pi-ip>:5050/control
```

The local display URL on the LAN is:

```text
http://<pi-ip>:5050/display
```

## Backups

The control page includes:

- `Download backup`
- `Import backup`

That lets you snapshot the current local game state and restore it later if needed.

## Verification

Useful local checks:

```bash
python -m py_compile app.py
```
