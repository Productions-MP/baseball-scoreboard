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
3. `scoreboard-streamdeck.service` listens for a USB-connected Elgato StreamDeck.
4. The display service starts Cage.
5. Cage launches Chromium in kiosk mode against the local `/display` page.
6. Phones and tablets on the LAN still use `/control` in a normal browser.

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
|   |-- maintain-wifi-failover.sh
|   |-- open-local.sh
|   |-- run-cage-browser.sh
|   |-- streamdeck_daemon.py
|   |-- switch-wifi-to-usb.sh
|   `-- start-kiosk-session.sh
|-- services/
|   |-- scoreboard-display.pam
|   |-- scoreboard-display.service
|   |-- scoreboard-local.service
|   |-- scoreboard-wifi-failover.service
|   |-- scoreboard-wifi-failover.timer
|   `-- scoreboard-streamdeck.service
|-- shared/
|   |-- default-state.json
|   `-- scoreboard_core.py
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
- `POST /api/action`
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

If you want the installer to move the active Wi-Fi connection from the built-in Pi radio (`wlan0`) to the Realtek USB adapter (`wlan1`), fill in these optional values before running `install.sh`:

```text
SCOREBOARD_WIFI_SSID=<your-ssid>
SCOREBOARD_WIFI_PSK=<your-password>
SCOREBOARD_WIFI_ALLOW_FALLBACK=0
SCOREBOARD_WIFI_PRIMARY_RECOVERY_GRACE_SECONDS=180
```

If those values are left blank and NetworkManager already has a saved profile for the current network, the installer will still try to reuse that profile on `wlan1`. The explicit SSID/PSK path is the most reliable option because it also lets the installer persist a dedicated `wlan1` profile.

If your Pi is sealed up somewhere that makes the onboard radio unusable, set `SCOREBOARD_WIFI_ALLOW_FALLBACK=0` before you run the installer. That puts the board in USB-only Wi-Fi mode so the maintenance timer keeps retrying `wlan1` and never intentionally rejoins the network over `wlan0`.

If you want the more forgiving maintenance behavior instead, leave `SCOREBOARD_WIFI_ALLOW_FALLBACK=1`. In that mode the timer keeps preferring and retrying `wlan1`, but it now waits out a recovery grace window before it brings up `wlan0`. The default is `180` seconds via `SCOREBOARD_WIFI_PRIMARY_RECOVERY_GRACE_SECONDS`, which keeps brief `wlan1` drops from constantly waking the onboard radio. Once `wlan1` recovers, the helper shuts `wlan0` back down again.

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
- install StreamDeck build/runtime dependencies
- install bundled fonts from `public/fonts`
- normalize `.env`
- detect a Realtek `0bda:c811` USB adapter on `wlan1`, attempt to move the active Wi-Fi link there, and only fall back to `wlan0` if fallback is still enabled
- install `scoreboard-local.service`
- install `scoreboard-display.service`
- install `scoreboard-streamdeck.service`
- install and enable `scoreboard-wifi-failover.timer` so the Pi keeps reasserting `wlan1`; with default settings it can also fail over/fail back with `wlan0`
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
- any attached StreamDeck or StreamDeck XL should light up with the local 5x3 control layout

## Services

### Flask app service

- Unit: `scoreboard-local.service`
- Runs from the repo root
- Restarts automatically on failure
- The web controller's restart/reboot/shutdown buttons rely on a sudoers rule installed by `scripts/install.sh`

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

### StreamDeck control service

- Unit: `scoreboard-streamdeck.service`
- Runs as `root` so it can talk to the USB deck and perform local restart/reboot/shutdown actions
- Uses the regular 5x3 StreamDeck layout on both the 15-key model and the XL
- Leaves the extra XL-only keys blank

Useful commands:

```bash
sudo systemctl status scoreboard-streamdeck.service
sudo journalctl -u scoreboard-streamdeck.service -b
sudo systemctl restart scoreboard-streamdeck.service
```

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
- `SCOREBOARD_STREAMDECK_BRIGHTNESS`
- `SCOREBOARD_STREAMDECK_POLL_SECONDS`
- `SCOREBOARD_STREAMDECK_CONFIRM_SECONDS`
- `SCOREBOARD_WIFI_SSID`
- `SCOREBOARD_WIFI_PSK`
- `SCOREBOARD_WIFI_ALLOW_FALLBACK`

Legacy `FALLBACK_*` environment names are still accepted by the Python app so old Pi installs do not break immediately, but the `SCOREBOARD_*` names above are the primary interface.

## Wi-Fi switchover

On install, `scripts/switch-wifi-to-usb.sh` now configures persistent `NetworkManager` profiles so `wlan1` is the preferred Wi-Fi interface. By default, `wlan0` remains the fallback when the USB adapter is missing or unavailable.

- Detection checks `wlan1`, `lsusb`, and the `wlan1` driver path for a USB-backed adapter.
- When NetworkManager is active, the installer writes a persistent per-device management policy for `wlan1` and `wlan0`.
- The installer creates two saved NetworkManager connections for the configured SSID: `scoreboard-wlan1` and `scoreboard-wlan0`.
- `scoreboard-wlan1` gets the higher autoconnect priority, lower route metric, and normal autoconnect so boot preference stays with the USB adapter.
- `scoreboard-wlan0` is saved as a standby profile with autoconnect disabled, so it does not join the network unless `wlan1` fails and the helper explicitly brings it up.
- If `.env` sets `SCOREBOARD_WIFI_ALLOW_FALLBACK=0`, the helper keeps `wlan0` disconnected and powered down so the Pi stays in USB-only Wi-Fi mode.
- `scoreboard-wifi-failover.timer` runs `scripts/maintain-wifi-failover.sh` every 20 seconds so the Pi keeps reasserting `wlan1`; when fallback is enabled it only brings up `wlan0` after `wlan1` has stayed unhealthy longer than `SCOREBOARD_WIFI_PRIMARY_RECOVERY_GRACE_SECONDS`, then shuts `wlan0` back down after `wlan1` recovers.
- When both radios are up, the route metrics still prefer `wlan1`, so the USB adapter remains the primary uplink.
- If NetworkManager is not available, the helper still falls back to the explicit `wpa_supplicant` path.

From the browser controller, you can also change these two Wi-Fi failover settings without editing `.env` directly:

- `Admin -> System Controls -> Wi-Fi Fallback`
- `Admin -> System Controls -> Wi-Fi Recovery Period`

Those menus use the same tap-to-apply picker style as the scoreboard layout selector. There is no separate save button; choosing an option writes it to the active env file and the failover timer usually picks it up within about 20 seconds.

## Chromium launch behavior

The kiosk launcher keeps Chromium as the renderer for the existing web UI.

- Chromium is not headless.
- Cage is only the Wayland kiosk compositor.
- Chromium opens the existing display route directly.
- The kiosk command parks the pointer in the bottom-right corner with `wlrctl` after Chromium appears, because current Cage releases do not offer a reliable built-in cursor-hide path for this kiosk use case.
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

By default, the display also has an idle safety flow based on the last saved scoreboard update:

- after 10 minutes, it swaps to a black screensaver with the baseball logo centered
- after 30 minutes, it goes fully black via blackout mode

You can tune those thresholds in `.env` with:

```text
SCOREBOARD_SCREENSAVER_IDLE_SECONDS=900
SCOREBOARD_BLACKOUT_IDLE_SECONDS=1800
```

Or from the controller menu:

- `Admin -> System Controls -> Logo Idle Timeout`
- `Admin -> System Controls -> Blackout Timeout`

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

### Local StreamDeck control

Plug the StreamDeck directly into the Pi over USB. The daemon always renders the standard 5-column by 3-row layout so the same muscle memory works on the regular StreamDeck and on the StreamDeck XL.

On the XL, only the top-left 5x3 block is used. The remaining keys stay blank.

Main page layout:

```text
| Inning - | Inning + | Guest Bat | Next At Bat | Home Bat |
| Ball -   | Ball +   | Strike -  | Strike +    | Clear B/S|
| Out -    | Out +    | Runs -    | Runs +      | Admin    |
```

Admin page layout:

```text
| Back     | Refresh  | Reset Game | State      | Count    |
| Restart App | Reboot Board | Shutdown Board | Guest Tot. | Home Tot.|
| Updated  | Device   | blank      | blank      | Status   |
```

Notes:

- `Restart App` restarts both `scoreboard-local.service` and `scoreboard-display.service`.
- `Reset Game`, `Restart App`, `Reboot Board`, and `Shutdown Board` require a second button press within the confirmation window before they run.
- Scoreboard buttons use the same local control key as the browser UI, pulled from `.env`.

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

### StreamDeck buttons stay dark or do nothing

Check the StreamDeck service logs:

```bash
sudo journalctl -u scoreboard-streamdeck.service -b
```

Then verify:

- the deck is connected directly to the Pi by USB
- `sudo systemctl status scoreboard-streamdeck.service`
- `python3 -m pip show streamdeck`
- the `.env` control key matches the one expected by the Flask app if you use `SCOREBOARD_CONTROL_KEY`

### USB Wi-Fi does not take over

Check adapter detection and route preference:

```bash
lsusb | grep 0bda:c811
ip link show wlan1
readlink /sys/class/net/wlan1/device/driver
ip route
```

If the Realtek adapter is present but never associates, confirm the driver is loaded:

```bash
lsmod | grep 8821cu
```

If the Pi is using `wpa_supplicant` instead of NetworkManager, make sure `.env` includes `SCOREBOARD_WIFI_SSID` and `SCOREBOARD_WIFI_PSK` before you rerun `scripts/install.sh`.

If the onboard radio is physically unusable in your enclosure, add `SCOREBOARD_WIFI_ALLOW_FALLBACK=0` to `.env` and rerun `scripts/install.sh` so the timer stops ever bringing `wlan0` online.

If you want maintenance SSH as a safety net, leave `SCOREBOARD_WIFI_ALLOW_FALLBACK=1`, rerun `scripts/install.sh`, and let the lower `SCOREBOARD_WIFI_FALLBACK_METRIC` keep `wlan1` as the preferred route whenever both links are available. If `wlan1` is just flapping, raise `SCOREBOARD_WIFI_PRIMARY_RECOVERY_GRACE_SECONDS` so the timer waits longer before it ever wakes `wlan0`. The timer will still drop `wlan0` again once `wlan1` is healthy.

### Cursor is still visible

Restart the display service:

```bash
~/baseball-scoreboard/scripts/open-local.sh
```

You can also verify the pointer parking manually from the live Wayland session:

```bash
export XDG_RUNTIME_DIR=/run/user/1000
export WAYLAND_DISPLAY="$(basename "$(ls /run/user/1000/wayland-* | head -n 1)")"
wlrctl pointer move 100000 100000
wlrctl pointer move 100000 100000
```

This default behavior is intentionally simple and plug-and-play. It keeps possible HDMI-CEC or other non-mouse input sources available instead of disabling them at the libinput level.

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
- `Admin -> System Controls -> Wi-Fi Fallback`
- `Admin -> System Controls -> Wi-Fi Recovery Period`

The backup actions let you snapshot the current local game state and restore it later. The Wi-Fi menus let you switch between USB-only mode and delayed fallback, plus choose the recovery grace window, directly from the controller.

## Verification

Useful checks after install:

```bash
python3 -m py_compile app.py shared/scoreboard_core.py scripts/streamdeck_daemon.py
sudo systemctl is-enabled scoreboard-local.service scoreboard-display.service scoreboard-streamdeck.service
sudo systemctl status scoreboard-local.service scoreboard-display.service scoreboard-streamdeck.service
curl -I http://127.0.0.1:5050/health
```
