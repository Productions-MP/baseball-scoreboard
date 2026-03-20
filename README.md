# Highlands Latin Baseball Scoreboard

Local-only baseball scoreboard software for a Raspberry Pi 4 Model B.

The Flask app still serves the existing HTML/CSS/JS UI:

- the display page at `/display`
- the control page at `/control`
- the JSON API at `/api/*`
- a websocket at `/ws` for live, low-latency state sync

The deployment model is now Raspberry Pi OS Lite friendly:

1. `scoreboard-local.service` starts the Flask app.
2. `scoreboard-display.service` takes over `tty1` on boot.
3. The display service starts Cage.
4. Cage launches Chromium in kiosk mode against the local `/display` page.
5. Phones and tablets on the LAN still use `/control` in a normal browser.

## Supported target

- Hardware: Raspberry Pi 4 Model B
- OS image: Raspberry Pi OS Lite
- Browser renderer: Chromium
- Kiosk compositor: Cage
- Primary display output: HDMI-0

This repo does not use a desktop autostart file, LXDE, labwc session startup, or a logged-in GUI session anymore.

## Project structure

```text
.
|-- .env.example
|-- .gitignore
|-- README.md
|-- app.py
|-- requirements.txt
|-- scripts/
|   |-- browser-app.sh
|   |-- install.sh
|   |-- install-fonts.sh
|   |-- kiosk.sh
|   |-- open-local.sh
|   `-- start-kiosk-session.sh
|-- services/
|   |-- scoreboard-display.pam
|   |-- scoreboard-display.service
|   `-- scoreboard-local.service
|-- shared/
|   `-- default-state.json
|-- static/
|   |-- app.js
|   |-- control.js
|   |-- display.js
|   `-- style.css
|-- public/
|   |-- fonts/
|   |   `-- README.md
|   `-- logo.png
`-- templates/
    |-- control.html
    `-- display.html
```

## Application architecture

### HTTP endpoints

- `GET /display`
- `GET /control`
- `GET /api/state`
- `POST /api/state`
- `POST /api/reset`
- `GET /health`

### Websocket endpoint

- `GET /ws`

The websocket remains the primary live transport.

- Display pages subscribe and redraw instantly when state changes.
- Control pages send updates over websocket when available.
- HTTP writes remain as a fallback if the socket is reconnecting.

### Local persistence

Runtime state is written to:

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

## Raspberry Pi OS Lite deployment

These instructions assume a Raspberry Pi 4 B booted into Raspberry Pi OS Lite with network access working.

### 0. Install git
```bash
sudo apt update
sudo apt install git -y
```

### 1. Clone the repo

Example location:

```bash
cd ~
git clone <your-repo-url> baseball-scoreboard
cd ~/baseball-scoreboard
cp .env.example .env
```

### 2. Apply the Pi display boot settings

On Raspberry Pi 4 with the VC4 KMS driver, HDMI output selection is handled by Linux/KMS rather than by Cage or Chromium. For this kiosk, the safest practical default is to force the first DRM HDMI connector, which maps to the Pi 4 primary HDMI output.

Connect the monitor to the Pi 4 HDMI-0 port, then verify these files.

`/boot/firmware/config.txt`

```ini
dtoverlay=vc4-kms-v3d
disable_overscan=1
```

`/boot/firmware/cmdline.txt`

Keep everything on one line and add:

```text
consoleblank=0 video=HDMI-A-1:D
```

Notes:

- `HDMI-A-1` is the first DRM HDMI connector and corresponds to HDMI-0 on Raspberry Pi 4.
- If you need to force a specific mode, replace `video=HDMI-A-1:D` with something like `video=HDMI-A-1:1920x1080M@60D`.
- If you intentionally want the other micro-HDMI port instead, use `HDMI-A-2`.

### 3. Run the installer

```bash
cd ~/baseball-scoreboard/scripts
chmod +x *.sh
./install.sh
```

The installer will:

- install Raspberry Pi OS Lite packages needed for the kiosk stack
- create or update the Python virtual environment
- install Python dependencies
- install bundled fonts from `public/fonts`
- generate an invisible cursor theme for the kiosk user
- normalize `.env`
- install `scoreboard-local.service`
- install `scoreboard-display.service`
- install the PAM file Cage needs for the tty session
- enable the services
- set the default boot target to `graphical.target`
- remove old desktop autostart and `.desktop` launcher artifacts if they exist

`graphical.target` here does not mean a desktop environment. It is only used as the boot target that brings up the tty-based Cage kiosk service.

### 4. Reboot

```bash
sudo reboot
```

After boot:

- Flask should listen on `0.0.0.0:5050`
- tty1 should start Cage
- Chromium should open `http://127.0.0.1:5050/display`
- the scoreboard should render on HDMI-0

## Services

### Flask app service

- Unit: `scoreboard-local.service`
- Runs from the repo root
- Restarts automatically on failure

Useful commands:

```bash
sudo systemctl status scoreboard-local.service
sudo journalctl -u scoreboard-local.service -b
sudo systemctl restart scoreboard-local.service
```

### Display kiosk service

- Unit: `scoreboard-display.service`
- Takes over `tty1`
- Starts a full user session through PAM/systemd-logind
- Launches `scripts/start-kiosk-session.sh`
- Waits for the local Flask `/health` endpoint before starting Chromium
- Restarts automatically on failure

Useful commands:

```bash
sudo systemctl status scoreboard-display.service
sudo journalctl -u scoreboard-display.service -b
sudo systemctl restart scoreboard-display.service
```

`scripts/open-local.sh` is now a convenience wrapper that restarts `scoreboard-display.service`.

## Manual app run

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

Legacy `FALLBACK_*` environment names are still accepted by the Python app so old Pi installs do not break immediately, but the `SCOREBOARD_*` names above are the primary interface.

## Chromium launch behavior

The kiosk launcher keeps Chromium as the renderer for the existing web UI.

- Chromium is not headless.
- Cage is only the Wayland kiosk compositor.
- Chromium opens the existing display route directly.
- The kiosk session exports an invisible Xcursor theme so the centered compositor cursor does not stay on screen.
- Startup suppresses first-run UI, restore bubbles, default-browser prompts, and infobars.
- The display service waits for the local app before Chromium starts.

## Futura on Raspberry Pi

The display stylesheet prefers Futura already, but Raspberry Pi OS will only use it if the font is present.

1. Put your licensed Futura files in [`public/fonts/`](public/fonts/) using the documented filenames from [`public/fonts/README.md`](public/fonts/README.md).
2. Re-run `~/baseball-scoreboard/scripts/install.sh` on the Pi.
3. Restart the kiosk or reboot the Pi.

If you include `.ttf` or `.otf` files, the installer copies them into `~/.local/share/fonts/baseball-scoreboard` and refreshes the font cache. If you include `.woff` or `.woff2` files with the documented names, Chromium can use them directly from the app even if they are not installed system-wide.

## Daily operation

### Local display

The display service targets:

```text
http://127.0.0.1:5050/display
```

To relaunch the kiosk session:

```bash
~/baseball-scoreboard/scripts/open-local.sh
```

### LAN control

Find the Pi IP address:

```bash
hostname -I
```

Then open this from another device on the same network:

```text
http://<pi-ip>:5050/control
```

The display page is also reachable over the LAN at:

```text
http://<pi-ip>:5050/display
```

## Troubleshooting

### Chromium never appears

Check the display service logs:

```bash
sudo journalctl -u scoreboard-display.service -b
```

Then verify:

- `command -v cage`
- `command -v chromium-browser || command -v chromium`
- `command -v dbus-run-session`
- `curl -I http://127.0.0.1:5050/health`

### Flask is up but the kiosk loops or exits

Check both services:

```bash
sudo systemctl status scoreboard-local.service
sudo systemctl status scoreboard-display.service
```

If the display service complains about permissions or sessions, confirm that:

- `/etc/pam.d/scoreboard-display` exists
- the app user is in the `video`, `render`, and `input` groups
- you rebooted after changing group membership

### Cursor is still visible

Confirm the invisible cursor theme exists for the kiosk user:

```bash
ls -R ~/.local/share/icons/scoreboard-invisible
```

Then restart the display service:

```bash
~/baseball-scoreboard/scripts/open-local.sh
```

### Screen stays black on Lite

Check the boot display settings:

```bash
cat /boot/firmware/config.txt
cat /boot/firmware/cmdline.txt
```

On Pi OS Lite, `consoleblank=0` belongs in `cmdline.txt`, not in a desktop power-management setting.

To confirm which HDMI connectors the kernel sees:

```bash
ls -1 /sys/class/drm/card?-HDMI-A-?
```

Expected on a Pi 4:

- `HDMI-A-1` for HDMI-0
- `HDMI-A-2` for HDMI-1

### Display is on the wrong monitor

Make sure the cable is connected to HDMI-0 and confirm `cmdline.txt` contains `video=HDMI-A-1:D`.

If you intentionally need the second port, switch that to `video=HDMI-A-2:D`.

## Backups

The control page includes:

- `Download backup`
- `Import backup`

That lets you snapshot the current local game state and restore it later.

## Verification

Useful checks after install:

```bash
python3 -m py_compile app.py
sudo systemctl is-enabled scoreboard-local.service scoreboard-display.service
sudo systemctl status scoreboard-local.service scoreboard-display.service
curl -I http://127.0.0.1:5050/health
```
