# ScoreHLS

ScoreHLS is local-first scoreboard software for a Raspberry Pi kiosk. The Raspberry Pi, browser, websocket, StreamDeck, Wi-Fi failover, idle/blackout, and installation pieces are shared infrastructure; sport rules and display designs are modules.

The first module is Baseball, with two linescore display designs.

## Application routes

- `/display` - kiosk display
- `/control` - phone/tablet controller
- `/api/state` - current state
- `/api/action` - sport action endpoint
- `/api/reset` - reset active sport game
- `/api/system` - restart/reboot/shutdown actions
- `/debug` - system debug timeline for Pi power, USB, and Wi-Fi status
- `/api/debug/system` - sampled system debug data
- `/ws` - live websocket updates

## State model

Runtime state is written to:

```text
runtime/scorehls_state.json
```

The state envelope is generic:

```json
{
  "schema_version": 1,
  "sport_id": "baseball",
  "template_id": "baseball-linescore-v2",
  "blackout": false,
  "game": {}
}
```

Each sport owns its `game` payload, validation, actions, and derived values. Baseball currently stores innings, half-inning, balls, strikes, outs, and the home/guest run arrays.

## Module layout

```text
shared/
  scorehls_core.py          generic state envelope and action dispatch
  scorehls_registry.py      registered sports and templates
  sports/
    baseball.py             baseball state, validation, actions, templates
templates/
  display_partials/
    baseball_v1.html
    baseball_v2.html
static/
  app.js                    browser-side ScoreHLS core
  control.js                controller UI
  display.js                display renderers
services/
  scorehls-local.service
  scorehls-display.service
  scorehls-streamdeck.service
  scorehls-wifi-failover.service
  scorehls-wifi-failover.timer
```

## Controller menu

The controller uses `Sport > Design`:

```text
Menu
  Admin
    Sport
      Design
      Baseball
```

Choosing a sport switches the shared state envelope to that sport and resets the sport-specific `game` payload to that module's default. Choosing a design only changes `template_id`.

## Configuration

Copy `.env.example` to `.env` before running locally or installing on the Pi.

Primary variables:

```text
SCOREHLS_DISPLAY_URL=http://127.0.0.1:5050/display
SCOREHLS_CONTROL_URL=http://127.0.0.1:5050/control
SCOREHLS_HOST=0.0.0.0
SCOREHLS_PORT=5050
SCOREHLS_CONTROL_KEY=
SCHOOL_NAME=Highlands Latin School
SCOREHLS_STATE_FILE=
SCOREHLS_STREAMDECK_BRIGHTNESS=45
SCOREHLS_WIFI_ALLOW_FALLBACK=1
SCOREHLS_SCREENSAVER_IDLE_SECONDS=900
SCOREHLS_BLACKOUT_IDLE_SECONDS=1800
SCOREHLS_DEBUG_SAMPLE_INTERVAL_SECONDS=60
SCOREHLS_DEBUG_RETENTION_DAYS=28
SCOREHLS_DEBUG_USB_RADIO_ID=0bda:c811
```

There are no legacy env aliases in this refactor.

## Manual run

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python app.py
```

Then open:

```text
http://127.0.0.1:5050/display
http://127.0.0.1:5050/control
```

## Raspberry Pi install

```bash
cd ~
git clone <your-repo-url> scorehls
cd ~/scorehls
cp .env.example .env
cd scripts
chmod +x *.sh
./install.sh
sudo reboot
```

The installer creates/enables:

- `scorehls-local.service`
- `scorehls-display.service`
- `scorehls-streamdeck.service`
- `scorehls-wifi-failover.timer`

The kiosk opens `SCOREHLS_DISPLAY_URL`; LAN controllers use `http://<pi-ip>:5050/control`.

## Verification

```bash
python3 -m py_compile app.py shared/scorehls_core.py shared/scorehls_registry.py shared/sports/baseball.py scripts/streamdeck_daemon.py
sudo systemctl status scorehls-local.service scorehls-display.service scorehls-streamdeck.service
curl -I http://127.0.0.1:5050/health
```
