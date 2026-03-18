(function bootstrapScoreboardCore() {
  const DEFAULT_STATE = {
    inning: 1,
    half: "top",
    balls: 0,
    strikes: 0,
    outs: 0,
    guest_runs: Array(10).fill(0),
    home_runs: Array(10).fill(0),
  };

  function cloneDefaultState() {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }

  function toInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function normalizeRuns(value) {
    const runs = Array.isArray(value) ? value : [];
    return Array.from({ length: 10 }, function mapRun(_, index) {
      return Math.max(0, toInt(runs[index], 0));
    });
  }

  function normalizeState(input) {
    const source = input || {};

    return {
      inning: clamp(toInt(source.inning, 1), 1, 10),
      half: source.half === "bottom" ? "bottom" : "top",
      balls: clamp(toInt(source.balls, 0), 0, 3),
      strikes: clamp(toInt(source.strikes, 0), 0, 2),
      outs: clamp(toInt(source.outs, 0), 0, 2),
      guest_runs: normalizeRuns(source.guest_runs),
      home_runs: normalizeRuns(source.home_runs),
    };
  }

  function serializeState(state) {
    return normalizeState(state);
  }

  function sumRuns(runs) {
    return (runs || []).reduce(function add(total, value) {
      return total + value;
    }, 0);
  }

  function withDerived(state) {
    const normalized = normalizeState(state);

    return {
      ...normalized,
      guest_total: sumRuns(normalized.guest_runs),
      home_total: sumRuns(normalized.home_runs),
      updated_at: state && state.updated_at ? state.updated_at : null,
      source: state && state.source ? state.source : (window.SCOREBOARD_CONFIG && window.SCOREBOARD_CONFIG.mode) || "primary",
    };
  }

  function formatTimestamp(value) {
    if (!value) {
      return "Not saved yet";
    }

    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(value));
    } catch (error) {
      return value;
    }
  }

  function getConfig() {
    return window.SCOREBOARD_CONFIG || {};
  }

  function getControlKey() {
    const config = getConfig();
    const storageName = config.keyStorageName || "scoreboard-control-key";

    try {
      return window.localStorage.getItem(storageName) || "";
    } catch (error) {
      return "";
    }
  }

  function setControlKey(value) {
    const config = getConfig();
    const storageName = config.keyStorageName || "scoreboard-control-key";

    try {
      if (value) {
        window.localStorage.setItem(storageName, value);
      } else {
        window.localStorage.removeItem(storageName);
      }
    } catch (error) {
      return;
    }
  }

  async function requestJson(url, options, needsAuth) {
    const config = getConfig();
    const headers = {
      Accept: "application/json",
      ...(options && options.headers ? options.headers : {}),
    };

    if (options && options.body) {
      headers["Content-Type"] = "application/json";
    }

    if (needsAuth && config.requireKey) {
      const controlKey = getControlKey();

      if (controlKey) {
        headers["x-scoreboard-key"] = controlKey;
      }
    }

    const response = await fetch(url, {
      credentials: "same-origin",
      ...(options || {}),
      headers,
    });

    let payload;

    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      const error = new Error((payload && payload.error) || "Request failed.");
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  function fetchState() {
    return requestJson(getConfig().endpoints.getState, { method: "GET" }, false);
  }

  function updateState(state) {
    return requestJson(
      getConfig().endpoints.updateState,
      {
        method: "POST",
        body: JSON.stringify(serializeState(state)),
      },
      true
    );
  }

  function resetState() {
    return requestJson(
      getConfig().endpoints.resetState,
      {
        method: "POST",
      },
      true
    );
  }

  function buildBackupFilename() {
    return "scoreboard-backup-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
  }

  window.ScoreboardCore = {
    buildBackupFilename: buildBackupFilename,
    cloneDefaultState: cloneDefaultState,
    fetchState: fetchState,
    formatTimestamp: formatTimestamp,
    getConfig: getConfig,
    getControlKey: getControlKey,
    resetState: resetState,
    serializeState: serializeState,
    setControlKey: setControlKey,
    updateState: updateState,
    withDerived: withDerived,
  };
})();
