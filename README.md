# Highlands Latin Baseball Scoreboard

A dead-simple hybrid baseball scoreboard system with two operating modes:

- `Primary mode`: Netlify-hosted display and control pages, persisted in Netlify Blobs, viewed on the Raspberry Pi kiosk browser.
- `Fallback mode`: a tiny Flask app on the Pi with local JSON state, used only when internet access is unavailable.

The two modes intentionally share the same state model and the same operator workflow, but they do **not** attempt fancy live sync. If you need to hand off state between them, export a JSON backup from one mode and import it into the other.

## Project structure

```text
.
|-- .env.example
|-- .gitignore
|-- README.md
|-- functions/
|   |-- _lib/state.js
|   |-- get-state.js
|   |-- reset-state.js
|   `-- update-state.js
|-- netlify.toml
|-- package.json
|-- pi-fallback/
|   |-- app.py
|   |-- fallback_state.json
|   |-- pi.env.example
|   |-- requirements.txt
|   |-- scripts/
|   |   |-- install.sh
|   |   |-- kiosk.sh
|   |   |-- open-fallback.sh
|   |   `-- open-primary.sh
|   |-- services/
|   |   `-- scoreboard-fallback.service
|   |-- static/
|   |   |-- app.js
|   |   |-- control.js
|   |   |-- display.js
|   |   `-- style.css
|   `-- templates/
|       |-- control.html
|       `-- display.html
|-- public/
|   |-- assets/
|   |   |-- app.js
|   |   |-- control.js
|   |   |-- display.js
|   |   `-- style.css
|   |-- control/
|   |   `-- index.html
|   `-- display/
|       `-- index.html
`-- shared/
    `-- default-state.json
```

## Shared state model

```json
{
  "inning": 1,
  "half": "top",
  "balls": 0,
  "strikes": 0,
  "outs": 0,
  "guest_runs": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "home_runs": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
}
```

Derived values are calculated in the UI and API responses:

- `guest_total = sum(guest_runs)`
- `home_total = sum(home_runs)`

Validation rules:

- `inning`: `1` through `10`
- `half`: `top` or `bottom`
- `balls`: `0` through `3`
- `strikes`: `0` through `2`
- `outs`: `0` through `2`
- inning run values: non-negative integers

## Part 1: Netlify primary app

### What it includes

- Static display page at `/display/`
- Static control page at `/control/`
- Netlify Functions API:
  - `GET /.netlify/functions/get-state`
  - `POST /.netlify/functions/update-state`
  - `POST /.netlify/functions/reset-state`
- Netlify Blobs storage for live scoreboard state
- Lightweight write protection using a control key header

### Deploy to Netlify

1. Push this repo to GitHub.
2. Create a Netlify site from the repo.
3. Set the publish directory to `public` and the Functions directory to `functions`.
   The included [netlify.toml](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/netlify.toml) already does this.
4. In Netlify site settings, add this environment variable:

```text
SCOREBOARD_CONTROL_KEY=choose-a-long-random-passphrase
```

5. Deploy the site.
6. Open:
   - display: `https://your-site.netlify.app/display/`
   - control: `https://your-site.netlify.app/control/`

### Local development

```bash
npm install
npx netlify dev
```

For local write testing, create a local `.env` from [.env.example](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/.env.example).

### Netlify Blobs notes

- The Functions in [functions/_lib/state.js](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/functions/_lib/state.js) store a single JSON document under the `baseball-scoreboard` Blob store.
- The first `GET` or `POST` seeds the default game state automatically if no state exists yet.
- State is stored outside the static deploy, so it survives redeploys.

### Protecting the control side

This project intentionally uses a lightweight, school-friendly protection model:

1. The display page can stay public.
2. The control page can stay at a private URL, but all write actions require the `SCOREBOARD_CONTROL_KEY`.
3. The operator types that key once into the control page, and the browser stores it locally for later saves.
4. The key is never hardcoded into the frontend.

Optional extra protection:

- Keep the `/control/` URL shared only with operators.
- Add Netlify site protection or access controls around the whole site if you want an additional outer gate.

## Part 2: Raspberry Pi fallback app

### What it includes

- Flask fallback server in [pi-fallback/app.py](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/pi-fallback/app.py)
- Local display page at `/display`
- Local control page at `/control`
- Local API:
  - `GET /api/state`
  - `POST /api/state`
  - `POST /api/reset`
- Local JSON persistence in [pi-fallback/fallback_state.json](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/pi-fallback/fallback_state.json)
- Atomic file writes for safer recovery after power loss
- A systemd service template and kiosk launcher scripts

### Raspberry Pi OS setup

These instructions assume Raspberry Pi OS with desktop, Chromium, and Wi‑Fi already working.

1. Clone the repo onto the Pi, for example to `/home/pi/baseball-scoreboard`.
2. Copy [pi-fallback/pi.env.example](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/pi-fallback/pi.env.example) to `pi-fallback/pi.env`.
3. Run the installer from the Pi:

```bash
cd ~/baseball-scoreboard/pi-fallback/scripts
./install.sh https://your-site.netlify.app/display/
```

The installer will:

- create a Python virtual environment
- install Flask
- create `pi-fallback/pi.env`
- install and start `scoreboard-fallback.service`
- add a kiosk autostart entry for primary mode
- create desktop launchers for primary and fallback display switching

### Manual fallback app setup

If you prefer to install manually instead of using the script:

```bash
cd ~/baseball-scoreboard/pi-fallback
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp pi.env.example pi.env
python app.py
```

### systemd fallback service

The service template is [pi-fallback/services/scoreboard-fallback.service](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/pi-fallback/services/scoreboard-fallback.service).

The installer replaces:

- `__REPO_ROOT__` with your repo path on the Pi
- `__PI_USER__` with your Pi user

Then it installs the rendered service to `/etc/systemd/system/scoreboard-fallback.service`.

### Chromium kiosk mode

The default kiosk launcher is [pi-fallback/scripts/kiosk.sh](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/pi-fallback/scripts/kiosk.sh).

It:

- kills any existing Chromium process
- relaunches Chromium in kiosk mode
- opens either the primary Netlify display URL or the fallback local URL
- uses `--window-size=768,192` to match the scoreboard layout target

Primary and fallback launch helpers:

- [pi-fallback/scripts/open-primary.sh](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/pi-fallback/scripts/open-primary.sh)
- [pi-fallback/scripts/open-fallback.sh](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/pi-fallback/scripts/open-fallback.sh)

### Auto-start on boot

The installer appends this command to LXDE autostart:

```text
@bash /home/pi/baseball-scoreboard/pi-fallback/scripts/open-primary.sh
```

That means:

- the Pi boots
- the fallback Flask service starts in the background
- Chromium opens the internet-hosted primary display by default

### How to switch between primary and fallback display modes on the Pi

Use either of these methods:

1. Double-click the desktop launcher created by the installer:
   - `Scoreboard Primary`
   - `Scoreboard Fallback`
2. Or run the scripts directly:

```bash
~/baseball-scoreboard/pi-fallback/scripts/open-primary.sh
~/baseball-scoreboard/pi-fallback/scripts/open-fallback.sh
```

This is a deliberate manual failover design. It is simpler and more dependable than a brittle automatic switchover loop.

### How to access fallback control on the LAN

Once the fallback Flask service is running:

1. Find the Pi IP address:

```bash
hostname -I
```

2. On the iPhone or iPad, while connected to the same local network, open:

```text
http://<pi-ip>:5050/control
```

The fallback display URL is:

```text
http://<pi-ip>:5050/display
```

## Back up and restore state

Both control pages include:

- `Download backup`
- `Import backup`

Recommended workflow when switching modes mid-game:

1. Open the control page in the mode currently in use.
2. Tap `Download backup`.
3. Switch the Pi to the other mode if needed.
4. Open the other control page.
5. Tap `Import backup`.

Because both modes use the same core JSON schema, the same backup file works in either direction.

## How to update branding later

Colors, typography, and layout live in:

- [public/assets/style.css](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/public/assets/style.css)
- [pi-fallback/static/style.css](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/pi-fallback/static/style.css)

The brand values are defined near the top as CSS custom properties:

- `--navy: #0c2340`
- `--gold: #ae9142`
- `--green: #009a49`
- `--font-display`: Futura with strong fallbacks

School naming and fallback environment labels are in:

- [public/display/index.html](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/public/display/index.html)
- [public/control/index.html](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/public/control/index.html)
- [pi-fallback/templates/display.html](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/pi-fallback/templates/display.html)
- [pi-fallback/templates/control.html](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/pi-fallback/templates/control.html)
- [pi-fallback/pi.env.example](/C:/Users/kuyper.reynolds.MP/GitHub/@KReynolds-MP/baseball-scoreboard/pi-fallback/pi.env.example)

## Reliability notes

- The primary and fallback modes are intentionally separate and understandable.
- The display pages use polling rather than sockets.
- The fallback app writes JSON atomically by writing a temporary file and then replacing the old file.
- The control pages save after every operator action so there is no hidden unsaved state.
- The fallback service runs continuously in the background, but the Pi only switches to the local display when an operator chooses it.

## Verification

Basic syntax verification completed locally:

- `python -m py_compile pi-fallback/app.py`
- `node --check` on all Netlify Functions and frontend JavaScript files
