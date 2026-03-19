(function bootstrapScoreboardCore() {
  const DEFAULT_STATE = {
    inning: 1,
    half: "top",
    ball: 0,
    strike: 0,
    out: 0,
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
      ball: clamp(toInt(source.ball ?? source.balls, 0), 0, 3),
      strike: clamp(toInt(source.strike ?? source.strikes, 0), 0, 2),
      out: clamp(toInt(source.out ?? source.outs, 0), 0, 2),
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
      source: state && state.source ? state.source : "scoreboard",
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

  function buildWebSocketUrl() {
    const config = getConfig();
    const configuredPath = config.endpoints && config.endpoints.websocket ? config.endpoints.websocket : "/ws";

    if (/^wss?:\/\//i.test(configuredPath)) {
      return configuredPath;
    }

    const protocol = window.location.protocol === "https:" ? "wss://" : "ws://";
    return protocol + window.location.host + configuredPath;
  }

  function createRealtimeChannel(handlers) {
    const options = handlers || {};
    const reconnectDelayMs = typeof options.reconnectDelayMs === "number" ? options.reconnectDelayMs : 1500;
    let socket = null;
    let reconnectTimer = 0;
    let manuallyClosed = false;

    function invoke(name, value) {
      if (typeof options[name] === "function") {
        options[name](value);
      }
    }

    function clearReconnect() {
      if (!reconnectTimer) {
        return;
      }

      window.clearTimeout(reconnectTimer);
      reconnectTimer = 0;
    }

    function scheduleReconnect() {
      if (manuallyClosed || reconnectTimer) {
        return;
      }

      reconnectTimer = window.setTimeout(function reconnectLater() {
        reconnectTimer = 0;
        connect();
      }, reconnectDelayMs);
    }

    function handleMessage(event) {
      let payload;

      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        invoke("onErrorMessage", {
          type: "error",
          error: "Received an invalid realtime message.",
          status: 500,
        });
        return;
      }

      if (payload.type === "error") {
        invoke("onErrorMessage", payload);
        return;
      }

      invoke("onState", payload);
    }

    function connect() {
      if (manuallyClosed) {
        return;
      }

      invoke("onConnecting");

      try {
        socket = new window.WebSocket(buildWebSocketUrl());
      } catch (error) {
        socket = null;
        invoke("onTransportError", error);
        invoke("onClose");
        scheduleReconnect();
        return;
      }

      socket.addEventListener("open", function onOpen() {
        invoke("onOpen");
        socket.send(JSON.stringify({ type: "hello" }));
      });

      socket.addEventListener("message", handleMessage);
      socket.addEventListener("error", function onError(error) {
        invoke("onTransportError", error);
      });
      socket.addEventListener("close", function onClose() {
        socket = null;
        invoke("onClose");
        scheduleReconnect();
      });
    }

    connect();

    return {
      close: function close() {
        manuallyClosed = true;
        clearReconnect();

        if (socket) {
          socket.close();
          socket = null;
        }
      },
      isOpen: function isOpen() {
        return Boolean(socket && socket.readyState === window.WebSocket.OPEN);
      },
      send: function send(payload) {
        if (!socket || socket.readyState !== window.WebSocket.OPEN) {
          return false;
        }

        socket.send(JSON.stringify(payload));
        return true;
      },
    };
  }

  window.ScoreboardCore = {
    buildBackupFilename: buildBackupFilename,
    buildWebSocketUrl: buildWebSocketUrl,
    cloneDefaultState: cloneDefaultState,
    createRealtimeChannel: createRealtimeChannel,
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
