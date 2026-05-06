(function bootstrapScoreHLSCore() {
  const FALLBACK_SPORTS = [
    {
      id: "baseball",
      label: "Baseball",
      default_template_id: "baseball-linescore-v2",
      templates: [
        {
          id: "baseball-linescore-v1",
          sport_id: "baseball",
          label: "Linescore v1",
          width: 768,
          height: 192,
          renderer: "baseball-linescore-v1",
        },
        {
          id: "baseball-linescore-v2",
          sport_id: "baseball",
          label: "Linescore v2",
          width: 768,
          height: 192,
          renderer: "baseball-linescore-v2",
        },
      ],
    },
    {
      id: "football",
      label: "Football",
      default_template_id: "football-clock-v1",
      templates: [
        {
          id: "football-clock-v1",
          sport_id: "football",
          label: "Clock v1",
          width: 768,
          height: 192,
          renderer: "football-clock-v1",
        },
      ],
    },
  ];

  const BASEBALL_DEFAULT_GAME = {
    inning: 1,
    half: "top",
    ball: 0,
    strike: 0,
    out: 0,
    guest_runs: Array(10).fill(0),
    home_runs: Array(10).fill(0),
  };

  const DEFAULT_PERIOD_SECONDS = 12 * 60;
  const FOOTBALL_DEFAULT_GAME = {
    quarter: 1,
    clock_seconds: DEFAULT_PERIOD_SECONDS,
    clock_running: false,
    clock_updated_at: null,
    guest_score: 0,
    home_score: 0,
  };
  const TEAM_NAME_MAX_LENGTH = 16;
  const DEFAULT_SETTINGS = {
    guest_team_name: "Guest",
    home_team_name: "Home",
    period_seconds: DEFAULT_PERIOD_SECONDS,
  };

  function normalizeTeamName(value, fallback) {
    if (typeof value === "string") {
      const trimmed = value.trim();

      if (trimmed) {
        return trimmed.slice(0, TEAM_NAME_MAX_LENGTH);
      }
    }

    return fallback;
  }

  function normalizePeriodSeconds(value) {
    const parsed = Number.parseInt(value, 10);
    const seconds = Number.isFinite(parsed) ? parsed : DEFAULT_PERIOD_SECONDS;
    return Math.max(60, Math.min(99 * 60, seconds));
  }

  function normalizeSettings(input) {
    const source = input && typeof input === "object" ? input : {};
    return {
      guest_team_name: normalizeTeamName(source.guest_team_name, DEFAULT_SETTINGS.guest_team_name),
      home_team_name: normalizeTeamName(source.home_team_name, DEFAULT_SETTINGS.home_team_name),
      period_seconds: normalizePeriodSeconds(source.period_seconds),
    };
  }

  function getConfig() {
    return window.SCOREHLS_CONFIG || {};
  }

  function toInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function normalizeBoolean(value, fallback) {
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      const candidate = value.trim().toLowerCase();

      if (candidate === "1" || candidate === "true" || candidate === "yes" || candidate === "on") {
        return true;
      }

      if (candidate === "0" || candidate === "false" || candidate === "no" || candidate === "off") {
        return false;
      }
    }

    if (typeof value === "number") {
      return value !== 0;
    }

    return Boolean(fallback);
  }

  function normalizeTemplate(template, fallback) {
    const baseTemplate = fallback || FALLBACK_SPORTS[0].templates[0];
    const source = template || {};
    const id = String(source.id || baseTemplate.id).trim() || baseTemplate.id;
    const label = String(source.label || baseTemplate.label).trim() || baseTemplate.label;
    const width = Math.max(1, toInt(source.width, baseTemplate.width));
    const height = Math.max(1, toInt(source.height, baseTemplate.height));

    return {
      ...baseTemplate,
      ...source,
      id: id,
      label: label,
      width: width,
      height: height,
    };
  }

  function normalizeSport(sport, fallback) {
    const baseSport = fallback || FALLBACK_SPORTS[0];
    const source = sport || {};
    const templates = Array.isArray(source.templates) && source.templates.length > 0 ? source.templates : baseSport.templates;
    const normalizedTemplates = templates.map(function mapTemplate(template, index) {
      return normalizeTemplate(template, baseSport.templates[index] || baseSport.templates[0]);
    });
    const defaultTemplateId = String(source.default_template_id || source.defaultTemplateId || "").trim();

    return {
      ...baseSport,
      ...source,
      id: String(source.id || baseSport.id).trim() || baseSport.id,
      label: String(source.label || baseSport.label).trim() || baseSport.label,
      default_template_id:
        normalizedTemplates.some(function hasTemplate(template) {
          return template.id === defaultTemplateId;
        })
          ? defaultTemplateId
          : normalizedTemplates[0].id,
      templates: normalizedTemplates,
    };
  }

  function getSports() {
    const config = getConfig();
    const configuredSports =
      Array.isArray(config.sports) && config.sports.length > 0 ? config.sports : FALLBACK_SPORTS;

    return configuredSports.map(function mapSport(sport, index) {
      return normalizeSport(sport, FALLBACK_SPORTS[index] || FALLBACK_SPORTS[0]);
    });
  }

  function normalizeSportId(value) {
    const candidate = String(value || "").trim();
    const sports = getSports();
    const match = sports.find(function findSport(sport) {
      return sport.id === candidate;
    });

    return match ? match.id : sports[0].id;
  }

  function getSportById(value) {
    const sports = getSports();
    const sportId = normalizeSportId(value);
    return (
      sports.find(function findSport(sport) {
        return sport.id === sportId;
      }) || sports[0]
    );
  }

  function getTemplatesForSport(sportId) {
    return getSportById(sportId).templates;
  }

  function normalizeTemplateId(value, sportId) {
    const sport = getSportById(sportId);
    const candidate = String(value || "").trim();
    const match = sport.templates.find(function findTemplate(template) {
      return template.id === candidate;
    });

    return match ? match.id : sport.default_template_id;
  }

  function getTemplateById(value, sportId) {
    const sport = getSportById(sportId);
    const templateId = normalizeTemplateId(value, sport.id);
    return (
      sport.templates.find(function findTemplate(template) {
        return template.id === templateId;
      }) || sport.templates[0]
    );
  }

  function getDefaultSportId() {
    const config = getConfig();
    return normalizeSportId(config.defaultSportId || (config.initialState && config.initialState.sport_id));
  }

  function getDefaultTemplateId(sportId) {
    const config = getConfig();
    const normalizedSportId = normalizeSportId(sportId || getDefaultSportId());
    return normalizeTemplateId(
      config.defaultTemplateId || (config.activeTemplate && config.activeTemplate.id),
      normalizedSportId
    );
  }

  function getActiveTemplate() {
    const config = getConfig();
    const initialState = config.initialState || {};
    const sportId = normalizeSportId(initialState.sport_id || (config.activeTemplate && config.activeTemplate.sport_id));
    return getTemplateById((config.activeTemplate && config.activeTemplate.id) || initialState.template_id, sportId);
  }

  function normalizeRuns(value) {
    const runs = Array.isArray(value) ? value : [];
    return Array.from({ length: 10 }, function mapRun(_, index) {
      return Math.max(0, toInt(runs[index], 0));
    });
  }

  function normalizeBaseballGame(input) {
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

  function normalizeFootballGame(input) {
    const source = input || {};
    const updatedAtRaw = source.clock_updated_at;
    const updatedAt = typeof updatedAtRaw === "string" && updatedAtRaw.trim() ? updatedAtRaw : null;
    return {
      quarter: clamp(toInt(source.quarter, 1), 1, 4),
      clock_seconds: Math.max(0, toInt(source.clock_seconds, 0)),
      clock_running: normalizeBoolean(source.clock_running, false),
      clock_updated_at: updatedAt,
      guest_score: Math.max(0, toInt(source.guest_score, 0)),
      home_score: Math.max(0, toInt(source.home_score, 0)),
    };
  }

  function defaultGameForSport(sportId) {
    const normalized = normalizeSportId(sportId);

    if (normalized === "baseball") {
      return JSON.parse(JSON.stringify(BASEBALL_DEFAULT_GAME));
    }

    if (normalized === "football") {
      return JSON.parse(JSON.stringify(FOOTBALL_DEFAULT_GAME));
    }

    return {};
  }

  function normalizeGameForSport(sportId, input) {
    const normalized = normalizeSportId(sportId);

    if (normalized === "baseball") {
      return normalizeBaseballGame(input);
    }

    if (normalized === "football") {
      return normalizeFootballGame(input);
    }

    return input && typeof input === "object" ? { ...input } : {};
  }

  function deriveGameForSport(sportId, game) {
    const normalized = normalizeSportId(sportId);

    if (normalized === "baseball") {
      const normalizedGame = normalizeBaseballGame(game);
      return {
        ...normalizedGame,
        guest_total: normalizedGame.guest_runs.reduce(function add(total, value) {
          return total + value;
        }, 0),
        home_total: normalizedGame.home_runs.reduce(function add(total, value) {
          return total + value;
        }, 0),
      };
    }

    if (normalized === "football") {
      return normalizeFootballGame(game);
    }

    return game && typeof game === "object" ? { ...game } : {};
  }

  function normalizeState(input) {
    const source = input || {};
    const sportId = normalizeSportId(source.sport_id);
    const sourceGame = source.game && typeof source.game === "object" ? source.game : defaultGameForSport(sportId);
    const mergedGameSource = sportId === "baseball" ? { ...sourceGame, ...source } : sourceGame;
    const templateId = normalizeTemplateId(source.template_id, sportId);
    const game = normalizeGameForSport(sportId, mergedGameSource);
    const derivedGame = deriveGameForSport(sportId, game);
    const settings = normalizeSettings(source.settings);

    return {
      schema_version: 1,
      sport_id: sportId,
      template_id: templateId,
      blackout: normalizeBoolean(source.blackout, false),
      game: game,
      settings: settings,
      ...derivedGame,
    };
  }

  function serializeState(state) {
    return normalizeState(state);
  }

  function cloneDefaultState(sportId) {
    const normalizedSportId = normalizeSportId(sportId || getDefaultSportId());
    return serializeState({
      sport_id: normalizedSportId,
      template_id: getDefaultTemplateId(normalizedSportId),
      blackout: false,
      game: defaultGameForSport(normalizedSportId),
      settings: { ...DEFAULT_SETTINGS },
    });
  }

  function withDerived(state) {
    const normalized = normalizeState(state);
    const sport = getSportById(normalized.sport_id);
    const template = getTemplateById(normalized.template_id, normalized.sport_id);
    const derivedGame = deriveGameForSport(normalized.sport_id, normalized.game);

    return {
      ...normalized,
      ...derivedGame,
      game: derivedGame,
      sport: {
        id: sport.id,
        label: sport.label,
        default_template_id: sport.default_template_id,
      },
      template: template,
      updated_at: state && state.updated_at ? state.updated_at : null,
      source: state && state.source ? state.source : "scorehls",
    };
  }

  function getIdleStatus(state, settings, nowMs) {
    const source = state || {};
    const idleSettings = settings || {};
    const updatedAt = source.updated_at ? Date.parse(source.updated_at) : NaN;
    const lastActivityAt = Number.isFinite(updatedAt) ? updatedAt : Date.now();
    const currentTimeMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const idleMs = Math.max(0, currentTimeMs - lastActivityAt);
    const screensaverIdleSeconds = Math.max(0, toInt(idleSettings.screensaver_idle_seconds, 0));
    const blackoutIdleSeconds = Math.max(0, toInt(idleSettings.blackout_idle_seconds, 0));
    const manualBlackout = normalizeBoolean(source.blackout, false);
    const idleBlackout = blackoutIdleSeconds > 0 && idleMs >= blackoutIdleSeconds * 1000;
    const blackout = manualBlackout || idleBlackout;
    const screensaver = screensaverIdleSeconds > 0 && idleMs >= screensaverIdleSeconds * 1000 && !blackout;

    return {
      updated_at: source.updated_at || null,
      last_activity_at: Number.isFinite(updatedAt) ? new Date(lastActivityAt).toISOString() : null,
      idle_ms: idleMs,
      screensaver: screensaver,
      blackout: blackout,
      manual_blackout: manualBlackout,
      idle_blackout: idleBlackout,
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

  function getControlKey() {
    const config = getConfig();
    const storageName = config.keyStorageName || "scorehls-control-key";

    try {
      return window.localStorage.getItem(storageName) || "";
    } catch (error) {
      return "";
    }
  }

  function setControlKey(value) {
    const config = getConfig();
    const storageName = config.keyStorageName || "scorehls-control-key";

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
        headers["x-scorehls-key"] = controlKey;
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

  function runSystemAction(action) {
    return requestJson(
      getConfig().endpoints.systemAction,
      {
        method: "POST",
        body: JSON.stringify({ action: action }),
      },
      true
    );
  }

  function fetchDisplayIdleSettings() {
    return requestJson(getConfig().endpoints.getDisplayIdleSettings, { method: "GET" }, true);
  }

  function updateDisplayIdleSettings(settings) {
    return requestJson(
      getConfig().endpoints.updateDisplayIdleSettings,
      {
        method: "POST",
        body: JSON.stringify(settings || {}),
      },
      true
    );
  }

  function fetchWifiSettings() {
    return requestJson(getConfig().endpoints.getWifiSettings, { method: "GET" }, true);
  }

  function updateWifiSettings(settings) {
    return requestJson(
      getConfig().endpoints.updateWifiSettings,
      {
        method: "POST",
        body: JSON.stringify(settings || {}),
      },
      true
    );
  }

  function buildBackupFilename() {
    return "scorehls-backup-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
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

  window.ScoreHLSCore = {
    buildBackupFilename: buildBackupFilename,
    buildWebSocketUrl: buildWebSocketUrl,
    cloneDefaultState: cloneDefaultState,
    createRealtimeChannel: createRealtimeChannel,
    fetchState: fetchState,
    fetchDisplayIdleSettings: fetchDisplayIdleSettings,
    fetchWifiSettings: fetchWifiSettings,
    formatTimestamp: formatTimestamp,
    getActiveTemplate: getActiveTemplate,
    getConfig: getConfig,
    getControlKey: getControlKey,
    getSportById: getSportById,
    getSports: getSports,
    getTemplateById: getTemplateById,
    getTemplatesForSport: getTemplatesForSport,
    getIdleStatus: getIdleStatus,
    resetState: resetState,
    runSystemAction: runSystemAction,
    serializeState: serializeState,
    setControlKey: setControlKey,
    updateDisplayIdleSettings: updateDisplayIdleSettings,
    updateState: updateState,
    updateWifiSettings: updateWifiSettings,
    withDerived: withDerived,
  };
})();
