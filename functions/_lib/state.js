const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "baseball-scoreboard";
const STATE_KEY = "live-state";
const CONTROL_HEADER = "x-scoreboard-key";

const DEFAULT_STATE = Object.freeze({
  inning: 1,
  half: "top",
  balls: 0,
  strikes: 0,
  outs: 0,
  guest_runs: Array(10).fill(0),
  home_runs: Array(10).fill(0),
});

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeRuns(value) {
  const runs = Array.isArray(value) ? value : [];

  return Array.from({ length: 10 }, (_, index) => Math.max(0, toInt(runs[index], 0)));
}

function normalizeState(input = {}) {
  return {
    inning: clamp(toInt(input.inning, DEFAULT_STATE.inning), 1, 10),
    half: input.half === "bottom" ? "bottom" : "top",
    balls: clamp(toInt(input.balls, DEFAULT_STATE.balls), 0, 3),
    strikes: clamp(toInt(input.strikes, DEFAULT_STATE.strikes), 0, 2),
    outs: clamp(toInt(input.outs, DEFAULT_STATE.outs), 0, 2),
    guest_runs: normalizeRuns(input.guest_runs),
    home_runs: normalizeRuns(input.home_runs),
  };
}

function mergeState(currentState, patch = {}) {
  const merged = {
    ...currentState,
    ...patch,
    guest_runs: patch.guest_runs !== undefined ? patch.guest_runs : currentState.guest_runs,
    home_runs: patch.home_runs !== undefined ? patch.home_runs : currentState.home_runs,
  };

  return normalizeState(merged);
}

function sumRuns(runs) {
  return runs.reduce((total, value) => total + value, 0);
}

function withDerived(state) {
  const normalized = normalizeState(state);

  return {
    ...normalized,
    guest_total: sumRuns(normalized.guest_runs),
    home_total: sumRuns(normalized.home_runs),
  };
}

function stampState(state, source) {
  return {
    ...normalizeState(state),
    updated_at: new Date().toISOString(),
    source,
  };
}

async function getBlobStore() {
  return getStore(STORE_NAME);
}

async function readState() {
  const store = await getBlobStore();
  const raw = await store.get(STATE_KEY, { type: "text" });

  if (!raw) {
    const seeded = stampState(cloneDefaultState(), "primary");
    await store.set(STATE_KEY, JSON.stringify(seeded));
    return seeded;
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...normalizeState(parsed),
      updated_at: parsed.updated_at || null,
      source: parsed.source || "primary",
    };
  } catch (error) {
    const resetState = stampState(cloneDefaultState(), "primary");
    await store.set(STATE_KEY, JSON.stringify(resetState));
    return resetState;
  }
}

async function writeState(nextState) {
  const store = await getBlobStore();
  const stamped = stampState(nextState, "primary");
  await store.set(STATE_KEY, JSON.stringify(stamped));
  return stamped;
}

function readControlKey() {
  return (process.env.SCOREBOARD_CONTROL_KEY || "").trim();
}

function ensureControlKeyConfigured() {
  if (!readControlKey()) {
    return jsonResponse(500, {
      ok: false,
      error: "SCOREBOARD_CONTROL_KEY is not configured.",
    });
  }

  return null;
}

function keysMatch(expected, provided) {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function authorizeControlRequest(event) {
  const configError = ensureControlKeyConfigured();

  if (configError) {
    return configError;
  }

  const expectedKey = readControlKey();
  const providedKey = String(event.headers?.[CONTROL_HEADER] || "").trim();

  if (!providedKey || !keysMatch(expectedKey, providedKey)) {
    return jsonResponse(401, {
      ok: false,
      error: "Unauthorized. Provide a valid control key.",
    });
  }

  return null;
}

function parseJsonBody(event) {
  if (!event.body) {
    return {};
  }

  try {
    return JSON.parse(event.body);
  } catch (error) {
    throw new Error("Invalid JSON request body.");
  }
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(payload),
  };
}

function buildApiPayload(mode, storedState) {
  return {
    ok: true,
    mode,
    updated_at: storedState.updated_at || null,
    state: {
      ...withDerived(storedState),
      updated_at: storedState.updated_at || null,
      source: storedState.source || mode,
    },
  };
}

module.exports = {
  DEFAULT_STATE,
  authorizeControlRequest,
  buildApiPayload,
  cloneDefaultState,
  jsonResponse,
  mergeState,
  parseJsonBody,
  readState,
  writeState,
};
