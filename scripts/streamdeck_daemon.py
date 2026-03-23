#!/usr/bin/env python3
from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib import error, request

from PIL import ImageDraw, ImageFont
from StreamDeck.DeviceManager import DeviceManager
from StreamDeck.ImageHelpers import PILHelper

BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILES = (
    BASE_DIR / "pi-fallback" / "pi.env",
    BASE_DIR / "pi.env",
    BASE_DIR / ".env",
)
STREAMDECK_KEYS = {
    15: list(range(15)),
    32: [0, 1, 2, 3, 4, 8, 9, 10, 11, 12, 16, 17, 18, 19, 20],
}
SCAN_INTERVAL_SECONDS = 5.0
ACTION_TIMEOUT_SECONDS = 4.0
OFFLINE_PLACEHOLDER = "--"

COLOR_TEXT = "#F6F1E8"
COLOR_MUTED = "#36495C"
COLOR_PANEL = "#112133"
COLOR_ACCENT = "#C88B2F"
COLOR_ACTIVE = "#176A4B"
COLOR_WARNING = "#8A5200"
COLOR_DANGER = "#8D1E1E"
COLOR_STATUS_OK = "#1F7A56"
COLOR_STATUS_BAD = "#814219"
COLOR_UNUSED = "#050709"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def env_value(primary_name: str, legacy_name: str | None = None, default: str = "") -> str:
    value = os.environ.get(primary_name)

    if value is None and legacy_name:
        value = os.environ.get(legacy_name)

    if value is None:
        return default

    return value


def clamp_int(value: str, minimum: int, maximum: int, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default

    return min(maximum, max(minimum, parsed))


def clamp_float(value: str, minimum: float, maximum: float, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default

    return min(maximum, max(minimum, parsed))


for env_file in ENV_FILES:
    load_env_file(env_file)


SCOREBOARD_PORT = clamp_int(env_value("SCOREBOARD_PORT", "FALLBACK_PORT", "5050"), 1, 65535, 5050)
BASE_URL = f"http://127.0.0.1:{SCOREBOARD_PORT}"
STATE_URL = f"{BASE_URL}/api/state"
ACTION_URL = f"{BASE_URL}/api/action"
RESET_URL = f"{BASE_URL}/api/reset"
CONTROL_KEY = env_value("SCOREBOARD_CONTROL_KEY", "FALLBACK_CONTROL_KEY", "").strip()
BRIGHTNESS = clamp_int(env_value("SCOREBOARD_STREAMDECK_BRIGHTNESS", default="45"), 0, 100, 45)
POLL_SECONDS = clamp_float(env_value("SCOREBOARD_STREAMDECK_POLL_SECONDS", default="2.0"), 0.5, 30.0, 2.0)
CONFIRM_SECONDS = clamp_float(env_value("SCOREBOARD_STREAMDECK_CONFIRM_SECONDS", default="4.0"), 1.0, 20.0, 4.0)
LOG_LEVEL = env_value("SCOREBOARD_STREAMDECK_LOG_LEVEL", default="INFO").upper()


logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(message)s",
)
LOGGER = logging.getLogger("scoreboard-streamdeck")


@dataclass(frozen=True)
class ButtonView:
    title: str = ""
    subtitle: str = ""
    footer: str = ""
    background: str = COLOR_PANEL
    foreground: str = COLOR_TEXT
    action: str | None = None
    requires_confirm: bool = False


@dataclass
class ArmedAction:
    action: str
    slot: int
    expires_at: float


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class LocalScoreboardApi:
    def __init__(self, state_url: str, action_url: str, reset_url: str, control_key: str):
        self.state_url = state_url
        self.action_url = action_url
        self.reset_url = reset_url
        self.control_key = control_key

    def fetch_state(self) -> dict[str, Any]:
        payload = self._request_json(self.state_url, method="GET")
        return payload.get("state") or {}

    def perform_action(self, action_name: str) -> dict[str, Any]:
        payload = self._request_json(
            self.action_url,
            method="POST",
            payload={"action": action_name},
        )
        return payload.get("state") or {}

    def reset_game(self) -> dict[str, Any]:
        payload = self._request_json(self.reset_url, method="POST")
        return payload.get("state") or {}

    def _request_json(self, url: str, method: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        body = None

        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload).encode("utf-8")

        if self.control_key:
            headers["x-scoreboard-key"] = self.control_key

        req = request.Request(url, data=body, headers=headers, method=method)

        try:
            with request.urlopen(req, timeout=ACTION_TIMEOUT_SECONDS) as response:
                raw_body = response.read().decode("utf-8")
        except error.HTTPError as exc:
            raw_body = exc.read().decode("utf-8", errors="replace")

            try:
                payload = json.loads(raw_body)
                message = str(payload.get("error") or raw_body or exc.reason)
            except json.JSONDecodeError:
                message = raw_body or str(exc.reason)

            raise ApiError(exc.code, message) from exc
        except error.URLError as exc:
            raise ApiError(503, str(exc.reason or "Unable to reach the local scoreboard server.")) from exc

        try:
            return json.loads(raw_body or "{}")
        except json.JSONDecodeError as exc:
            raise ApiError(500, "The local scoreboard server returned invalid JSON.") from exc


class DeckSession:
    def __init__(self, deck: Any, serial_number: str, event_queue: queue.Queue[tuple[str, str, int, bool]]):
        self.deck = deck
        self.serial_number = serial_number
        self.event_queue = event_queue
        self.key_count = int(deck.key_count())
        self.slot_to_key = STREAMDECK_KEYS[self.key_count]
        self.key_to_slot = {key: slot for slot, key in enumerate(self.slot_to_key)}
        self.deck_name = self._deck_name()
        self.page = "main"
        self.armed_action: ArmedAction | None = None
        self.snapshot: dict[str, Any] | None = None
        self.online = False
        self.status_text = ""
        self.status_expires_at = 0.0
        self.dirty = True
        self.last_signature: tuple[Any, ...] | None = None

    def _deck_name(self) -> str:
        name = "StreamDeck"

        try:
            name = str(self.deck.deck_type())
        except Exception:
            pass

        if "XL" in name.upper():
            return "XL"

        return "REG"

    def open(self) -> None:
        self.deck.reset()
        self.deck.set_brightness(BRIGHTNESS)

        def on_key_change(_deck: Any, key: int, is_pressed: bool) -> None:
            self.event_queue.put(("key", self.serial_number, key, is_pressed))

        self.deck.set_key_callback(on_key_change)
        self.mark_dirty()

    def close(self) -> None:
        try:
            self.deck.reset()
        except Exception:
            pass

        try:
            self.deck.close()
        except Exception:
            pass

    def connected(self) -> bool:
        try:
            return bool(self.deck.connected())
        except Exception:
            return False

    def set_snapshot(self, snapshot: dict[str, Any] | None, online: bool) -> None:
        if snapshot is not None:
            next_signature = json.dumps(snapshot, sort_keys=True)
            current_signature = json.dumps(self.snapshot, sort_keys=True) if self.snapshot is not None else None

            if next_signature != current_signature:
                self.snapshot = snapshot
                self.mark_dirty()

        if self.online != online:
            self.online = online
            self.mark_dirty()

    def set_status(self, message: str, duration_seconds: float = 5.0) -> None:
        self.status_text = message.strip()
        self.status_expires_at = time.monotonic() + max(0.5, duration_seconds)
        self.mark_dirty()

    def mark_dirty(self) -> None:
        self.dirty = True

    def expire_transients(self, now: float) -> None:
        changed = False

        if self.armed_action and now >= self.armed_action.expires_at:
            self.armed_action = None
            changed = True

        if self.status_text and now >= self.status_expires_at:
            self.status_text = ""
            self.status_expires_at = 0.0
            changed = True

        if changed:
            self.mark_dirty()

    def status_label(self) -> str:
        if self.status_text:
            return self.status_text

        if self.online:
            return "READY"

        return "OFFLINE"

    def physical_key_to_slot(self, key: int) -> int | None:
        return self.key_to_slot.get(key)

    def render(self) -> None:
        views = self._build_views()
        signature = tuple(
            (view.title, view.subtitle, view.footer, view.background, view.foreground, view.action, view.requires_confirm)
            for view in views
        )

        if not self.dirty and signature == self.last_signature:
            return

        used_keys = set(self.slot_to_key)

        for key_index in range(self.key_count):
            if key_index not in used_keys:
                self.deck.set_key_image(key_index, self._native_image(ButtonView(background=COLOR_UNUSED)))

        for slot, key_index in enumerate(self.slot_to_key):
            self.deck.set_key_image(key_index, self._native_image(views[slot]))

        self.last_signature = signature
        self.dirty = False

    def _native_image(self, view: ButtonView) -> bytes:
        image = PILHelper.create_key_image(self.deck)
        draw = ImageDraw.Draw(image)
        width, height = image.size

        draw.rectangle((0, 0, width, height), fill=view.background)
        draw.rectangle((4, 4, width - 4, height - 4), outline="#0F131A", width=2)

        title_font = self._font(max(12, height // 6))
        subtitle_font = self._font(max(14, height // 4))
        footer_font = self._font(max(10, height // 8))

        self._draw_centered_text(draw, width, height, 14, view.title, title_font, view.foreground)
        self._draw_centered_text(draw, width, height, 35, view.subtitle, subtitle_font, view.foreground)
        self._draw_centered_text(draw, width, height, height - 14, view.footer, footer_font, view.foreground)

        return PILHelper.to_native_format(self.deck, image)

    def _font(self, size: int) -> ImageFont.ImageFont:
        try:
            return ImageFont.truetype("DejaVuSans-Bold.ttf", size=size)
        except OSError:
            return ImageFont.load_default()

    def _draw_centered_text(
        self,
        draw: ImageDraw.ImageDraw,
        width: int,
        height: int,
        center_y: int,
        text: str,
        font: ImageFont.ImageFont,
        fill: str,
    ) -> None:
        value = str(text or "").strip()

        if not value:
            return

        bbox = draw.textbbox((0, 0), value, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]
        x = max(4, (width - text_width) / 2)
        y = max(4, min(height - text_height - 4, center_y - (text_height / 2)))
        draw.text((x, y), value, font=font, fill=fill)

    def _summary(self) -> dict[str, str]:
        state = self.snapshot or {}
        inning = str(state.get("inning", OFFLINE_PLACEHOLDER))
        half = "BOT" if state.get("half") == "bottom" else "TOP"
        ball = str(state.get("ball", OFFLINE_PLACEHOLDER))
        strike = str(state.get("strike", OFFLINE_PLACEHOLDER))
        out = str(state.get("out", OFFLINE_PLACEHOLDER))
        guest_total = str(state.get("guest_total", OFFLINE_PLACEHOLDER))
        home_total = str(state.get("home_total", OFFLINE_PLACEHOLDER))
        updated_at = format_timestamp(state.get("updated_at"))

        current_runs = OFFLINE_PLACEHOLDER
        if state:
            inning_index = max(0, min(9, int(state.get("inning", 1)) - 1))
            team_key = "home_runs" if state.get("half") == "bottom" else "guest_runs"
            runs = state.get(team_key) or []

            if inning_index < len(runs):
                current_runs = str(runs[inning_index])

        next_half = "BOT" if half == "TOP" else "TOP"
        next_inning = inning if half == "TOP" else str(min(10, int(state.get("inning", 1)) + 1)) if state else OFFLINE_PLACEHOLDER

        return {
            "inning": inning,
            "half": half,
            "ball": ball,
            "strike": strike,
            "out": out,
            "runs": current_runs,
            "next_half": next_half,
            "next_inning": next_inning,
            "guest_total": guest_total,
            "home_total": home_total,
            "updated_at": updated_at,
        }

    def _build_views(self) -> list[ButtonView]:
        summary = self._summary()
        status = self.status_label()
        status_background = COLOR_STATUS_OK if self.online else COLOR_STATUS_BAD

        if self.page == "admin":
            views = [
                ButtonView("BACK", "MAIN", background=COLOR_MUTED, action="page:main"),
                ButtonView("REFRESH", subtitle=status, background=COLOR_MUTED, action="refresh-state"),
                ButtonView("RESET", "GAME", background=COLOR_WARNING, action="reset-game", requires_confirm=True),
                ButtonView("STATE", f"{summary['half']} {summary['inning']}", footer="LIVE", background=COLOR_MUTED),
                ButtonView("COUNT", f"{summary['ball']}-{summary['strike']}-{summary['out']}", footer="B-S-O", background=COLOR_MUTED),
                ButtonView("RESTART", "APP", background=COLOR_WARNING, action="restart-scoreboard", requires_confirm=True),
                ButtonView("REBOOT", "BOARD", background=COLOR_DANGER, action="reboot-pi", requires_confirm=True),
                ButtonView("SHUTDOWN", "BOARD", background=COLOR_DANGER, action="shutdown-pi", requires_confirm=True),
                ButtonView("GUEST", summary["guest_total"], footer="TOTAL", background=COLOR_MUTED),
                ButtonView("HOME", summary["home_total"], footer="TOTAL", background=COLOR_MUTED),
                ButtonView("UPDATED", summary["updated_at"], footer="LOCAL", background=COLOR_MUTED),
                ButtonView("DEVICE", self.deck_name, footer="5x3", background=COLOR_MUTED),
                ButtonView(background=COLOR_UNUSED),
                ButtonView(background=COLOR_UNUSED),
                ButtonView("ADMIN", status, background=status_background),
            ]
        else:
            guest_active = summary["half"] == "TOP"
            home_active = summary["half"] == "BOT"
            views = [
                ButtonView("INNING", "-", summary["inning"], background=COLOR_MUTED, action="inning-down"),
                ButtonView("INNING", "+", summary["inning"], background=COLOR_MUTED, action="inning-up"),
                ButtonView("GUEST", "AT BAT" if guest_active else "READY", background=COLOR_ACTIVE if guest_active else COLOR_MUTED, action="set-guest-at-bat"),
                ButtonView("NEXT", summary["next_half"], summary["next_inning"], background=COLOR_ACCENT, action="next-half"),
                ButtonView("HOME", "AT BAT" if home_active else "READY", background=COLOR_ACTIVE if home_active else COLOR_MUTED, action="set-home-at-bat"),
                ButtonView("BALL", "-", summary["ball"], background=COLOR_MUTED, action="ball-down"),
                ButtonView("BALL", "+", summary["ball"], background=COLOR_MUTED, action="ball-up"),
                ButtonView("STRIKE", "-", summary["strike"], background=COLOR_MUTED, action="strike-down"),
                ButtonView("STRIKE", "+", summary["strike"], background=COLOR_MUTED, action="strike-up"),
                ButtonView("CLEAR", "B/S", f"{summary['ball']}-{summary['strike']}", background=COLOR_ACCENT, action="clear-ball-strikes"),
                ButtonView("OUT", "-", summary["out"], background=COLOR_MUTED, action="out-down"),
                ButtonView("OUT", "+", summary["out"], background=COLOR_MUTED, action="out-up"),
                ButtonView("RUNS", "-", summary["runs"], background=COLOR_MUTED, action="current-runs-down"),
                ButtonView("RUNS", "+", summary["runs"], background=COLOR_MUTED, action="current-runs-up"),
                ButtonView("ADMIN", status, background=status_background, action="page:admin"),
            ]

        if self.armed_action:
            armed_slot = self.armed_action.slot
            armed_view = views[armed_slot]
            views[armed_slot] = ButtonView(
                "CONFIRM",
                "PRESS",
                "AGAIN",
                background=COLOR_DANGER,
                action=armed_view.action,
                requires_confirm=armed_view.requires_confirm,
            )

        return views


def format_timestamp(value: Any) -> str:
    if not value:
        return "--:--"

    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone().strftime("%I:%M:%S").lstrip("0")
    except ValueError:
        return str(value)[:8]


class StreamDeckController:
    def __init__(self) -> None:
        self.api = LocalScoreboardApi(STATE_URL, ACTION_URL, RESET_URL, CONTROL_KEY)
        self.event_queue: queue.Queue[tuple[str, str, int, bool]] = queue.Queue()
        self.sessions: dict[str, DeckSession] = {}
        self.latest_state: dict[str, Any] | None = None
        self.latest_online = False
        self.next_scan_at = 0.0
        self.next_poll_at = 0.0

    def run(self) -> None:
        LOGGER.info("Starting StreamDeck control daemon on %s", BASE_URL)
        try:
            while True:
                now = time.monotonic()

                self._expire_transients(now)

                if now >= self.next_scan_at:
                    self.scan_for_devices()
                    self.next_scan_at = now + SCAN_INTERVAL_SECONDS

                if now >= self.next_poll_at:
                    self.refresh_state()
                    self.next_poll_at = now + POLL_SECONDS

                self.render_all()

                timeout = self._next_timeout(time.monotonic())

                try:
                    event = self.event_queue.get(timeout=timeout)
                except queue.Empty:
                    continue

                self.handle_event(event)
        finally:
            for session in self.sessions.values():
                session.close()

    def _next_timeout(self, now: float) -> float:
        deadlines = [self.next_scan_at, self.next_poll_at]

        for session in self.sessions.values():
            if session.armed_action:
                deadlines.append(session.armed_action.expires_at)
            if session.status_text:
                deadlines.append(session.status_expires_at)

        future_deadlines = [deadline for deadline in deadlines if deadline > now]

        if not future_deadlines:
            return 0.25

        return max(0.1, min(0.5, min(future_deadlines) - now))

    def _expire_transients(self, now: float) -> None:
        for session in self.sessions.values():
            session.expire_transients(now)

    def scan_for_devices(self) -> None:
        for serial_number, session in list(self.sessions.items()):
            if session.connected():
                continue

            LOGGER.warning("StreamDeck disconnected: %s", serial_number)
            session.close()
            del self.sessions[serial_number]

        discovered = DeviceManager().enumerate()

        for deck in discovered:
            try:
                deck.open()
            except Exception:
                continue

            try:
                key_count = int(deck.key_count())

                if key_count not in STREAMDECK_KEYS:
                    LOGGER.info("Ignoring unsupported StreamDeck with %s keys", key_count)
                    deck.close()
                    continue

                serial_number = str(deck.get_serial_number())

                if serial_number in self.sessions:
                    deck.close()
                    continue

                session = DeckSession(deck, serial_number, self.event_queue)
                session.open()
                session.set_snapshot(self.latest_state, self.latest_online)
                session.set_status("CONNECTED", duration_seconds=4.0)
                self.sessions[serial_number] = session
                LOGGER.info("Connected StreamDeck %s (%s keys)", serial_number, key_count)
            except Exception:
                try:
                    deck.close()
                except Exception:
                    pass

    def refresh_state(self) -> None:
        try:
            next_state = self.api.fetch_state()
        except ApiError as exc:
            LOGGER.warning("State refresh failed: %s", exc)
            self.latest_online = False

            for session in self.sessions.values():
                session.set_snapshot(None, False)
                session.set_status(f"ERR {exc.status}", duration_seconds=4.0)

            return

        self.latest_state = next_state
        self.latest_online = True

        for session in self.sessions.values():
            session.set_snapshot(next_state, True)

    def render_all(self) -> None:
        for serial_number, session in list(self.sessions.items()):
            try:
                session.render()
            except Exception as exc:
                LOGGER.warning("Render failed for %s: %s", serial_number, exc)
                session.mark_dirty()

    def handle_event(self, event: tuple[str, str, int, bool]) -> None:
        event_type, serial_number, key_index, is_pressed = event

        if event_type != "key" or not is_pressed:
            return

        session = self.sessions.get(serial_number)

        if not session:
            return

        slot = session.physical_key_to_slot(key_index)

        if slot is None:
            return

        views = session._build_views()
        button = views[slot]

        if not button.action:
            session.armed_action = None
            session.mark_dirty()
            return

        action = button.action
        now = time.monotonic()

        if button.requires_confirm:
            if (
                session.armed_action
                and session.armed_action.action == action
                and session.armed_action.slot == slot
                and now < session.armed_action.expires_at
            ):
                session.armed_action = None
            else:
                session.armed_action = ArmedAction(action=action, slot=slot, expires_at=now + CONFIRM_SECONDS)
                session.set_status("ARMED", duration_seconds=CONFIRM_SECONDS)
                return
        else:
            session.armed_action = None

        self.execute_action(session, action)

    def execute_action(self, session: DeckSession, action: str) -> None:
        try:
            if action == "page:admin":
                session.page = "admin"
                session.mark_dirty()
                return

            if action == "page:main":
                session.page = "main"
                session.mark_dirty()
                return

            if action == "refresh-state":
                self.refresh_state()
                session.set_status("REFRESHED", duration_seconds=3.0)
                return

            if action == "reset-game":
                next_state = self.api.reset_game()
                self._apply_state_update(next_state, status_message="RESET")
                return

            if action == "restart-scoreboard":
                self._run_admin_command(
                    ["systemctl", "restart", "scoreboard-local.service", "scoreboard-display.service"],
                    status_message="RESTARTING",
                )
                self.latest_online = False

                for open_session in self.sessions.values():
                    open_session.set_snapshot(None, False)

                return

            if action == "reboot-pi":
                self._run_admin_command(["shutdown", "-r", "now"], status_message="REBOOTING")
                return

            if action == "shutdown-pi":
                self._run_admin_command(["shutdown", "now"], status_message="SHUTTING")
                return

            next_state = self.api.perform_action(action)
            self._apply_state_update(next_state, status_message="SAVED")
        except ApiError as exc:
            LOGGER.warning("Action %s failed: %s", action, exc)
            self.latest_online = False

            for open_session in self.sessions.values():
                open_session.set_status(f"ERR {exc.status}", duration_seconds=4.0)
                open_session.set_snapshot(None, False)
        except subprocess.CalledProcessError as exc:
            LOGGER.warning("Admin command failed for %s: %s", action, exc)

            for open_session in self.sessions.values():
                open_session.set_status("CMD ERR", duration_seconds=5.0)

    def _apply_state_update(self, next_state: dict[str, Any], status_message: str) -> None:
        self.latest_state = next_state
        self.latest_online = True

        for session in self.sessions.values():
            session.set_snapshot(next_state, True)
            session.set_status(status_message, duration_seconds=3.0)

    def _run_admin_command(self, command: list[str], status_message: str) -> None:
        for session in self.sessions.values():
            session.set_status(status_message, duration_seconds=6.0)

        LOGGER.info("Running admin command: %s", " ".join(command))
        subprocess.run(command, check=True)


def main() -> None:
    controller = StreamDeckController()
    controller.run()


if __name__ == "__main__":
    main()
