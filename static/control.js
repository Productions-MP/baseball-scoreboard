(function runControlPage() {
  if (!window.ScoreboardCore) {
    return;
  }

  const core = window.ScoreboardCore;
  const config = core.getConfig();
  const HISTORY_LIMIT = 150;
  const POWER_CONFIRM_MS = 2500;

  const undoButton = document.getElementById("undo-button");
  const redoButton = document.getElementById("redo-button");
  const menuButton = document.getElementById("menu-button");
  const powerButton = document.getElementById("power-button");
  const powerLabel = document.getElementById("power-label");
  const powerIndicator = document.getElementById("power-indicator");
  const menuPanel = document.getElementById("menu-panel");
  const menuPanelBackdrop = document.getElementById("menu-panel-backdrop");
  const menuPanelBody = menuPanel ? menuPanel.querySelector(".menu-panel-body") : null;
  const menuBackButton = document.getElementById("menu-back-button");
  const menuPanelTitle = document.getElementById("menu-panel-title");
  const menuCloseButton = document.getElementById("menu-close-button");
  const logoutButton = document.getElementById("logout-button");
  const inningEditOverlay = document.getElementById("inning-edit-overlay");
  const authOverlay = document.getElementById("auth-overlay");
  const authNote = document.getElementById("auth-note");
  const authSkipButton = document.getElementById("auth-skip-button");
  const controlKeyInput = document.getElementById("control-key-input");
  const saveKeyButton = document.getElementById("save-key-button");
  const previewFrame = document.getElementById("control-preview-iframe");
  const designSelect = document.getElementById("scoreboard-design-select");
  const designOptions = Array.from(document.querySelectorAll("[data-design-option]"));
  const wifiSettingsNotes = Array.from(document.querySelectorAll("[data-wifi-settings-note]"));
  const wifiFallbackOptions = Array.from(document.querySelectorAll("[data-wifi-fallback-option]"));
  const wifiGraceOptions = Array.from(document.querySelectorAll("[data-wifi-grace-option]"));
  const displayIdleSettingsNotes = Array.from(document.querySelectorAll("[data-display-idle-settings-note]"));
  const displayIdleOptions = Array.from(document.querySelectorAll("[data-display-idle-option]"));
  const displayBlackoutOptions = Array.from(document.querySelectorAll("[data-display-blackout-option]"));
  const liveInningLabel = document.getElementById("live-inning-label");
  const ballValue = document.getElementById("ball-value");
  const strikeValue = document.getElementById("strike-value");
  const outValue = document.getElementById("out-value");
  const currentRunsValue = document.getElementById("current-runs-value");
  const guestBatButton = document.getElementById("guest-bat-button");
  const homeBatButton = document.getElementById("home-bat-button");
  const guestBatArrow = document.getElementById("guest-bat-arrow");
  const homeBatArrow = document.getElementById("home-bat-arrow");
  const inningEditor = document.getElementById("inning-editor");
  const saveNote = document.getElementById("save-note");
  const backupFileInput = document.getElementById("backup-file-input");
  const restartSystemButton = document.getElementById("restart-system-button");
  const rebootPiButton = document.getElementById("reboot-pi-button");
  const shutdownPiButton = document.getElementById("shutdown-pi-button");
  const menuLevels = {
    main: { title: "Menu", element: document.getElementById("menu-level-main") },
    admin: { title: "Admin", element: document.getElementById("menu-level-admin") },
    design: { title: "Design", element: document.getElementById("menu-level-design") },
    backup: { title: "Backup / Reset", element: document.getElementById("menu-level-backup") },
    system: { title: "System Controls", element: document.getElementById("menu-level-system") },
    "wifi-fallback": { title: "Wi-Fi Fallback", element: document.getElementById("menu-level-wifi-fallback") },
    "wifi-grace": { title: "Wi-Fi Recovery Period", element: document.getElementById("menu-level-wifi-grace") },
    "display-idle": { title: "Logo Idle Timeout", element: document.getElementById("menu-level-display-idle") },
    "display-blackout": { title: "Blackout Timeout", element: document.getElementById("menu-level-display-blackout") },
  };

  let state = config.initialState
    ? { ...core.serializeState(config.initialState), updated_at: config.initialState.updated_at || null }
    : { ...core.cloneDefaultState(), updated_at: null };
  let saveInFlight = false;
  let pendingRequestId = "";
  let pendingActionType = "";
  let realtime = null;
  let initialLoadComplete = false;
  let authDismissed = false;
  let undoStack = [];
  let redoStack = [];
  let activeMenuLevel = "main";
  let menuHistory = [];
  let powerConfirmTimeoutId = 0;
  let wifiSettingsBusy = false;
  let wifiSettings = {
    fallback_mode: "allow-fallback",
    primary_recovery_grace_seconds: 180,
  };
  let wifiSettingsRequestId = 0;
  let displayIdleSettings = {
    screensaver_idle_seconds: 900,
    blackout_idle_seconds: 1800,
  };
  let displayIdleSettingsRequestId = 0;

  function formatDesignLabel(design) {
    return design.label + " (" + design.width + "x" + design.height + ")";
  }

  function setStatusMessage(message, isError) {
    saveNote.textContent = message;
    saveNote.classList.toggle("is-error", Boolean(isError));
  }

  function setWifiFailoverMessage(message, isError) {
    wifiSettingsNotes.forEach(function updateWifiSettingsNote(note) {
      note.textContent = message;
      note.classList.toggle("is-error", Boolean(isError));
    });
  }

  function setDisplayIdleMessage(message, isError) {
    displayIdleSettingsNotes.forEach(function updateDisplayIdleSettingsNote(note) {
      note.textContent = message;
      note.classList.toggle("is-error", Boolean(isError));
    });
  }

  function setConnectionState(label, isOffline) {
    menuButton.classList.toggle("is-offline", Boolean(isOffline));
    menuButton.title = label;
  }

  function nextRequestId() {
    return "req-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function currentInningIndex(snapshot) {
    const source = snapshot || state;
    return Math.max(0, Math.min(9, source.inning - 1));
  }

  function currentBattingTeamKey(snapshot) {
    const source = snapshot || state;
    return source.half === "bottom" ? "home_runs" : "guest_runs";
  }

  function snapshotState() {
    return core.serializeState(state);
  }

  function idleStatusForState(snapshot) {
    return core.getIdleStatus(snapshot || state, displayIdleSettings);
  }

  function sameState(left, right) {
    return JSON.stringify(core.serializeState(left)) === JSON.stringify(core.serializeState(right));
  }

  function clearHistory() {
    undoStack = [];
    redoStack = [];
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    undoButton.disabled = undoStack.length === 0 || saveInFlight;
    redoButton.disabled = redoStack.length === 0 || saveInFlight;
  }

  function pushUndoState(previousState) {
    undoStack.push(core.serializeState(previousState));

    if (undoStack.length > HISTORY_LIMIT) {
      undoStack.shift();
    }

    redoStack = [];
    updateHistoryButtons();
  }

  function applyLocalState(nextState, options) {
    const settings = options || {};
    const previousState = snapshotState();
    const normalizedNext = {
      ...core.serializeState(nextState),
      updated_at:
        settings.updatedAt !== undefined
          ? settings.updatedAt
          : (nextState && nextState.updated_at) || state.updated_at || null,
    };

    if (sameState(previousState, normalizedNext)) {
      return;
    }

    if (!settings.skipHistory) {
      pushUndoState(previousState);
    }

    if (!settings.keepRedo) {
      redoStack = [];
    }

    state = normalizedNext;
    render();
    saveState();
    updateHistoryButtons();
  }

  function toggleOverlay(element, isVisible) {
    if (!element) {
      return;
    }

    element.hidden = !isVisible;
  }

  function toggleWifiSettingsBusy(isBusy, busyLabel) {
    wifiSettingsBusy = Boolean(isBusy);
    const disabled = wifiSettingsBusy;
    const title = wifiSettingsBusy && busyLabel ? busyLabel : "";

    wifiFallbackOptions.forEach(function toggleWifiFallbackOption(option) {
      option.disabled = disabled;
      option.title = title;
    });

    wifiGraceOptions.forEach(function toggleWifiGraceOption(option) {
      option.disabled = disabled;
      option.title = title;
    });
  }

  function toggleDisplayIdleSettingsBusy(isBusy, busyLabel) {
    const disabled = Boolean(isBusy);
    const title = disabled && busyLabel ? busyLabel : "";

    displayIdleOptions.forEach(function toggleDisplayIdleOption(option) {
      option.disabled = disabled;
      option.title = title;
    });

    displayBlackoutOptions.forEach(function toggleDisplayBlackoutOption(option) {
      option.disabled = disabled;
      option.title = title;
    });
  }

  function cancelPowerConfirm() {
    if (powerConfirmTimeoutId) {
      window.clearTimeout(powerConfirmTimeoutId);
      powerConfirmTimeoutId = 0;
    }

    if (powerButton) {
      powerButton.classList.remove("is-confirming");
    }
  }

  function showMenuLevel(levelKey) {
    const nextLevel = menuLevels[levelKey] || menuLevels.main;

    Object.keys(menuLevels).forEach(function hideOtherLevels(key) {
      const level = menuLevels[key];

      if (level && level.element) {
        level.element.hidden = key !== levelKey;
      }
    });

    activeMenuLevel = levelKey;

    if (menuPanelTitle) {
      menuPanelTitle.textContent = nextLevel.title;
    }

    if (menuBackButton) {
      menuBackButton.hidden = menuHistory.length === 0;
    }

    if (menuPanelBody) {
      menuPanelBody.scrollTop = 0;
    }

    if (levelKey === "wifi-fallback" || levelKey === "wifi-grace") {
      loadWifiSettingsIntoMenu();
    }

    if (levelKey === "display-idle" || levelKey === "display-blackout") {
      loadDisplayIdleSettingsIntoMenu();
    }
  }

  function navigateMenuForward(levelKey) {
    if (!menuLevels[levelKey] || levelKey === activeMenuLevel) {
      return;
    }

    cancelPowerConfirm();
    menuHistory.push(activeMenuLevel);
    showMenuLevel(levelKey);
  }

  function navigateMenuBack() {
    if (menuHistory.length === 0) {
      return;
    }

    cancelPowerConfirm();
    showMenuLevel(menuHistory.pop());
  }

  function closeMenuPanel() {
    cancelPowerConfirm();
    menuHistory = [];
    showMenuLevel("main");
    menuPanel.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
  }

  function openMenuPanel() {
    menuHistory = [];
    showMenuLevel("main");
    menuPanel.hidden = false;
    menuButton.setAttribute("aria-expanded", "true");
  }

  function handlePowerClick() {
    const idleStatus = idleStatusForState(state);
    const blackoutEnabled = idleStatus.blackout;
    const manualBlackout = Boolean(state.blackout);

    if (!blackoutEnabled && powerButton && !powerButton.classList.contains("is-confirming")) {
      cancelPowerConfirm();
      powerButton.classList.add("is-confirming");
      syncPowerButton();
      powerConfirmTimeoutId = window.setTimeout(function clearPendingPower() {
        cancelPowerConfirm();
        syncPowerButton();
      }, POWER_CONFIRM_MS);
      return;
    }

    cancelPowerConfirm();

    if (idleStatus.idle_blackout && !manualBlackout) {
      closeMenuPanel();
      saveState();
      return;
    }

    handleAction("toggle-blackout");
  }

  function commitDesignSelection(value) {
    if (!designSelect || !value || designSelect.value === value) {
      return;
    }

    designSelect.value = value;
    designSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function updateAuthOverlay() {
    const hasControlKey = Boolean(core.getControlKey());
    const shouldPrompt = !hasControlKey && !authDismissed;

    authSkipButton.hidden = Boolean(config.requireKey);
    authNote.textContent = config.requireKey
      ? "This scoreboard requires the control password before any changes can be made."
      : "Enter the control password if one is configured, or skip for this session.";

    toggleOverlay(authOverlay, shouldPrompt);

    if (shouldPrompt) {
      window.requestAnimationFrame(function focusPasswordField() {
        controlKeyInput.focus();
      });
    }
  }

  function applyWifiSettings(settings) {
    if (!settings) {
      return;
    }

    wifiSettings = {
      fallback_mode: settings.fallback_mode === "usb-only" ? "usb-only" : "allow-fallback",
      primary_recovery_grace_seconds: Math.max(0, Number.parseInt(settings.primary_recovery_grace_seconds, 10) || 0),
    };
    syncWifiSettingsSelection();
  }

  function syncWifiSettingsSelection() {
    wifiFallbackOptions.forEach(function syncFallbackOption(option) {
      const isSelected = option.dataset.value === wifiSettings.fallback_mode;
      option.classList.toggle("is-selected", isSelected);
      option.setAttribute("aria-pressed", String(isSelected));

      const status = option.querySelector("[data-wifi-fallback-status]");

      if (status) {
        status.hidden = !isSelected;
      }
    });

    wifiGraceOptions.forEach(function syncGraceOption(option) {
      const isSelected = Number.parseInt(option.dataset.value, 10) === wifiSettings.primary_recovery_grace_seconds;
      option.classList.toggle("is-selected", isSelected);
      option.setAttribute("aria-pressed", String(isSelected));

      const status = option.querySelector("[data-wifi-grace-status]");

      if (status) {
        status.hidden = !isSelected;
      }
    });
  }

  async function loadWifiSettingsIntoMenu() {
    const requestId = ++wifiSettingsRequestId;
    setWifiFailoverMessage(
      "Loading current Wi-Fi failover settings...",
      false
    );
    toggleWifiSettingsBusy(true, "Loading...");

    try {
      const payload = await core.fetchWifiSettings();
      if (requestId !== wifiSettingsRequestId) {
        return;
      }
      applyWifiSettings(payload);
      setWifiFailoverMessage("", false);
    } catch (error) {
      if (requestId !== wifiSettingsRequestId) {
        return;
      }
      if (error.status === 401) {
        handleControlKeyRejected("Wi-Fi settings");
      } else {
        setWifiFailoverMessage("Unable to load Wi-Fi failover settings: " + error.message, true);
      }
    } finally {
      toggleWifiSettingsBusy(false);
    }
  }

  async function saveWifiFailoverSettings(nextSettings) {
    if (config.requireKey && !core.getControlKey()) {
      authDismissed = false;
      render();
      setWifiFailoverMessage("Enter the control password to change Wi-Fi failover settings.", true);
      return;
    }

    const nextGraceSeconds = Number.parseInt(nextSettings.primary_recovery_grace_seconds, 10);
    const payloadToSave = {
      fallback_mode: nextSettings.fallback_mode || wifiSettings.fallback_mode,
      primary_recovery_grace_seconds: Number.isFinite(nextGraceSeconds)
        ? Math.max(0, nextGraceSeconds)
        : wifiSettings.primary_recovery_grace_seconds,
    };

    toggleWifiSettingsBusy(true, "Applying...");
    setWifiFailoverMessage("Applying Wi-Fi failover change...", false);

    try {
      const payload = await core.updateWifiSettings(payloadToSave);
      applyWifiSettings(payload);
      setWifiFailoverMessage(
        payload.message || "Wi-Fi failover settings saved.",
        false
      );
      setStatusMessage("Wi-Fi failover settings saved.", false);
    } catch (error) {
      if (error.status === 401) {
        handleControlKeyRejected("Wi-Fi settings");
      } else {
        setWifiFailoverMessage("Unable to save Wi-Fi failover settings: " + error.message, true);
      }
    } finally {
      toggleWifiSettingsBusy(false);
    }
  }

  function commitWifiFallbackSelection(value) {
    if (!value || wifiSettingsBusy || value === wifiSettings.fallback_mode) {
      return;
    }

    saveWifiFailoverSettings({
      fallback_mode: value,
      primary_recovery_grace_seconds: wifiSettings.primary_recovery_grace_seconds,
    });
  }

  function commitWifiGraceSelection(value) {
    const graceSeconds = Math.max(0, Number.parseInt(value, 10) || 0);

    if (wifiSettingsBusy || graceSeconds === wifiSettings.primary_recovery_grace_seconds) {
      return;
    }

    saveWifiFailoverSettings({
      fallback_mode: wifiSettings.fallback_mode,
      primary_recovery_grace_seconds: graceSeconds,
    });
  }

  function applyDisplayIdleSettings(settings) {
    if (!settings) {
      return;
    }

    displayIdleSettings = {
      screensaver_idle_seconds: Math.max(0, Number.parseInt(settings.screensaver_idle_seconds, 10) || 0),
      blackout_idle_seconds: Math.max(0, Number.parseInt(settings.blackout_idle_seconds, 10) || 0),
    };
    syncDisplayIdleSelection();
    syncPowerButton();
  }

  function syncDisplayIdleSelection() {
    displayIdleOptions.forEach(function syncDisplayIdleOption(option) {
      const isSelected = Number.parseInt(option.dataset.value, 10) === displayIdleSettings.screensaver_idle_seconds;
      option.classList.toggle("is-selected", isSelected);
      option.setAttribute("aria-pressed", String(isSelected));

      const status = option.querySelector("[data-display-idle-status]");

      if (status) {
        status.hidden = !isSelected;
      }
    });

    displayBlackoutOptions.forEach(function syncDisplayBlackoutOption(option) {
      const isSelected = Number.parseInt(option.dataset.value, 10) === displayIdleSettings.blackout_idle_seconds;
      option.classList.toggle("is-selected", isSelected);
      option.setAttribute("aria-pressed", String(isSelected));

      const status = option.querySelector("[data-display-blackout-status]");

      if (status) {
        status.hidden = !isSelected;
      }
    });
  }

  async function loadDisplayIdleSettingsIntoMenu() {
    const requestId = ++displayIdleSettingsRequestId;
    setDisplayIdleMessage("Loading display idle settings...", false);
    toggleDisplayIdleSettingsBusy(true, "Loading...");

    try {
      const payload = await core.fetchDisplayIdleSettings();
      if (requestId !== displayIdleSettingsRequestId) {
        return;
      }
      applyDisplayIdleSettings(payload);
      setDisplayIdleMessage("", false);
    } catch (error) {
      if (requestId !== displayIdleSettingsRequestId) {
        return;
      }
      if (error.status === 401) {
        handleControlKeyRejected("Display idle settings");
      } else {
        setDisplayIdleMessage("Unable to load display idle settings: " + error.message, true);
      }
    } finally {
      toggleDisplayIdleSettingsBusy(false);
    }
  }

  async function refreshDisplayIdleSettingsSilently() {
    if (config.requireKey && !core.getControlKey()) {
      return;
    }

    try {
      const payload = await core.fetchDisplayIdleSettings();
      applyDisplayIdleSettings(payload);
    } catch (error) {
      return;
    }
  }

  async function saveDisplayIdleSettings(nextSettings) {
    if (config.requireKey && !core.getControlKey()) {
      authDismissed = false;
      render();
      setDisplayIdleMessage("Enter the control password to change display idle settings.", true);
      return;
    }

    const nextScreensaverSeconds = Number.parseInt(nextSettings.screensaver_idle_seconds, 10);
    const nextBlackoutSeconds = Number.parseInt(nextSettings.blackout_idle_seconds, 10);
    const payloadToSave = {
      screensaver_idle_seconds: Number.isFinite(nextScreensaverSeconds)
        ? Math.max(0, nextScreensaverSeconds)
        : displayIdleSettings.screensaver_idle_seconds,
      blackout_idle_seconds: Number.isFinite(nextBlackoutSeconds)
        ? Math.max(0, nextBlackoutSeconds)
        : displayIdleSettings.blackout_idle_seconds,
    };

    toggleDisplayIdleSettingsBusy(true, "Applying...");
    setDisplayIdleMessage("Applying display idle change...", false);

    try {
      const payload = await core.updateDisplayIdleSettings(payloadToSave);
      applyDisplayIdleSettings(payload);
      setDisplayIdleMessage(payload.message || "Display idle settings saved.", false);
      setStatusMessage("Display idle settings saved.", false);
    } catch (error) {
      if (error.status === 401) {
        handleControlKeyRejected("Display idle settings");
      } else {
        setDisplayIdleMessage("Unable to save display idle settings: " + error.message, true);
      }
    } finally {
      toggleDisplayIdleSettingsBusy(false);
    }
  }

  function commitDisplayIdleSelection(value) {
    const seconds = Math.max(0, Number.parseInt(value, 10) || 0);

    if (seconds === displayIdleSettings.screensaver_idle_seconds) {
      return;
    }

    saveDisplayIdleSettings({
      screensaver_idle_seconds: seconds,
      blackout_idle_seconds: displayIdleSettings.blackout_idle_seconds,
    });
  }

  function commitDisplayBlackoutSelection(value) {
    const seconds = Math.max(0, Number.parseInt(value, 10) || 0);

    if (seconds === displayIdleSettings.blackout_idle_seconds) {
      return;
    }

    saveDisplayIdleSettings({
      screensaver_idle_seconds: displayIdleSettings.screensaver_idle_seconds,
      blackout_idle_seconds: seconds,
    });
  }

  function updateSummary() {
    const derived = core.withDerived(state);
    const guestBatting = derived.half !== "bottom";
    const runsIndex = currentInningIndex(derived);
    const battingRuns = derived[currentBattingTeamKey(derived)][runsIndex];

    liveInningLabel.textContent = "Inning " + derived.inning;
    ballValue.textContent = String(derived.ball);
    strikeValue.textContent = String(derived.strike);
    outValue.textContent = String(derived.out);
    currentRunsValue.textContent = String(battingRuns);

    guestBatButton.classList.toggle("is-active", guestBatting);
    homeBatButton.classList.toggle("is-active", !guestBatting);
    guestBatArrow.classList.toggle("is-active", guestBatting);
    homeBatArrow.classList.toggle("is-active", !guestBatting);
  }

  function syncPowerButton() {
    if (!powerButton || !powerLabel) {
      return;
    }

    const blackoutEnabled = idleStatusForState(state).blackout;
    const isOn = !blackoutEnabled;
    const isConfirming = powerButton.classList.contains("is-confirming");

    powerButton.classList.toggle("is-on", isOn);

    if (powerIndicator) {
      powerIndicator.setAttribute("aria-hidden", "true");
    }

    powerLabel.textContent = isOn
      ? (isConfirming ? "Confirm Turn Off" : "Turn Off")
      : "Turn On";
  }

  function syncDesignSelection() {
    const design = core.withDerived(state).design;

    if (designSelect) {
      designSelect.value = design.id;
    }

    designOptions.forEach(function syncDesignOption(option) {
      const isSelected = option.dataset.value === design.id;
      option.classList.toggle("is-selected", isSelected);
      option.setAttribute("aria-pressed", String(isSelected));

      const status = option.querySelector("[data-design-status]");

      if (status) {
        status.hidden = !isSelected;
      }
    });

    if (previewFrame) {
      previewFrame.style.aspectRatio = design.width + " / " + design.height;
    }
  }

  function buildInningEditor() {
    const innings = Array.from({ length: 10 }, function build(_, index) {
      return (
        '<div class="inning-column">' +
        '<div class="inning-number">Inning ' + (index + 1) + "</div>" +
        '<label class="inning-input-wrap">Guest<input class="inning-input" data-team="guest" data-index="' + index + '" type="number" min="0" inputmode="numeric"></label>' +
        '<label class="inning-input-wrap">Home<input class="inning-input" data-team="home" data-index="' + index + '" type="number" min="0" inputmode="numeric"></label>' +
        "</div>"
      );
    });

    inningEditor.innerHTML = innings.join("");
  }

  function syncEditorInputs() {
    const inputs = inningEditor.querySelectorAll(".inning-input");

    inputs.forEach(function syncInput(input) {
      const index = Number.parseInt(input.dataset.index, 10);
      const team = input.dataset.team;
      const value = team === "guest" ? state.guest_runs[index] : state.home_runs[index];
      input.value = String(value);
      input.classList.toggle("is-live-inning", index === currentInningIndex());
    });
  }

  function render() {
    updateSummary();
    syncPowerButton();
    syncDesignSelection();
    syncEditorInputs();
    updateAuthOverlay();
    updateHistoryButtons();
  }

  function replaceState(nextState, options) {
    const settings = options || {};
    state = {
      ...core.serializeState(nextState),
      updated_at:
        settings.updatedAt !== undefined
          ? settings.updatedAt
          : (nextState && nextState.updated_at) || state.updated_at || null,
    };

    if (!settings.preserveHistory) {
      clearHistory();
    }

    render();
  }

  function clearBallStrikes(targetState) {
    targetState.ball = 0;
    targetState.strike = 0;
  }

  function clearCount(targetState) {
    clearBallStrikes(targetState);
    targetState.out = 0;
  }

  function nextHalf(targetState) {
    if (targetState.half === "top") {
      targetState.half = "bottom";
    } else {
      targetState.half = "top";
      targetState.inning = Math.min(10, targetState.inning + 1);
    }

    clearCount(targetState);
  }

  function recordOut(targetState) {
    if (targetState.out >= 2) {
      nextHalf(targetState);
      return;
    }

    targetState.out += 1;
    clearBallStrikes(targetState);
  }

  function adjustCurrentBattingRuns(targetState, delta) {
    const index = currentInningIndex(targetState);
    const key = currentBattingTeamKey(targetState);
    targetState[key][index] = Math.max(0, targetState[key][index] + delta);
  }

  function handleControlKeyRejected(prefix) {
    core.setControlKey("");
    controlKeyInput.value = "";
    authDismissed = false;
    render();
    setStatusMessage(prefix + " failed: control password rejected.", true);
  }

  async function saveStateOverHttp(snapshot) {
    const payload = await core.updateState(snapshot);
    pendingRequestId = "";
    pendingActionType = "";
    replaceState(payload.state, {
      preserveHistory: true,
      updatedAt: payload.updated_at || (payload.state && payload.state.updated_at) || null,
    });
    setConnectionState("HTTP ONLY", false);
    setStatusMessage("Saved " + core.formatTimestamp(payload.updated_at || payload.state.updated_at), false);
  }

  async function saveState() {
    if (saveInFlight) {
      return;
    }

    if (config.requireKey && !core.getControlKey()) {
      authDismissed = false;
      render();
      setStatusMessage("Enter the control password to save changes.", true);
      return;
    }

    saveInFlight = true;
    updateHistoryButtons();
    pendingRequestId = nextRequestId();
    pendingActionType = "save";
    setStatusMessage("Saving...", false);

    const realtimeSent =
      realtime &&
      realtime.send({
        type: "update_state",
        request_id: pendingRequestId,
        state: snapshotState(),
        control_key: core.getControlKey(),
      });

    if (realtimeSent) {
      return;
    }

    try {
      await saveStateOverHttp(snapshotState());
    } catch (error) {
      pendingRequestId = "";
      pendingActionType = "";
      setConnectionState("SAVE FAILED", true);

      if (error.status === 401) {
        handleControlKeyRejected("Save");
      } else {
        setStatusMessage("Save failed: " + error.message, true);
      }
    } finally {
      saveInFlight = false;
      render();
    }
  }

  async function resetStateOverHttp() {
    const payload = await core.resetState();
    pendingRequestId = "";
    pendingActionType = "";
    replaceState(payload.state, {
      preserveHistory: true,
      updatedAt: payload.updated_at || (payload.state && payload.state.updated_at) || null,
    });
    setConnectionState("HTTP ONLY", false);
    setStatusMessage("Game reset complete.", false);
  }

  async function loadState() {
    try {
      const payload = await core.fetchState();
      replaceState(payload.state);
      initialLoadComplete = true;

      if (!realtime || !realtime.isOpen()) {
        setConnectionState("HTTP READY", false);
      }

      setStatusMessage("Connected to the scoreboard server.", false);
    } catch (error) {
      setConnectionState("OFFLINE", true);
      setStatusMessage("Unable to reach the scoreboard API right now.", true);
    }
  }

  function handleRealtimeState(payload) {
    replaceState(payload.state, {
      preserveHistory: true,
      updatedAt: payload.updated_at || (payload.state && payload.state.updated_at) || null,
    });
    setConnectionState("WS LIVE", false);

    if (!initialLoadComplete) {
      initialLoadComplete = true;
      clearHistory();
      setStatusMessage("Connected directly to the Pi websocket.", false);
    }

    if (payload.request_id && payload.request_id === pendingRequestId) {
      const completedAction = pendingActionType;
      pendingRequestId = "";
      pendingActionType = "";
      saveInFlight = false;
      setStatusMessage(
        completedAction === "reset" ? "Game reset complete." : "Saved " + core.formatTimestamp(payload.updated_at || payload.state.updated_at),
        false
      );
      return;
    }

    clearHistory();
  }

  function handleRealtimeError(payload) {
    const failedAction = pendingActionType;

    if (payload.request_id && payload.request_id === pendingRequestId) {
      pendingRequestId = "";
      pendingActionType = "";
      saveInFlight = false;
      updateHistoryButtons();
    }

    if (payload.status === 401) {
      handleControlKeyRejected(failedAction === "reset" ? "Reset" : "Save");
      return;
    }

    setStatusMessage(payload.error || (failedAction === "reset" ? "Realtime reset failed." : "Realtime update failed."), true);
  }

  function connectRealtime() {
    realtime = core.createRealtimeChannel({
      onClose: function onClose() {
        setConnectionState("WS RETRYING", true);

        if (saveInFlight) {
          const pendingSnapshot = snapshotState();
          const pendingKind = pendingActionType;
          saveInFlight = false;
          pendingRequestId = "";
          pendingActionType = "";
          const retryAction = pendingKind === "reset" ? resetStateOverHttp() : saveStateOverHttp(pendingSnapshot);

          retryAction.catch(function onFallbackError(error) {
            setConnectionState("SAVE FAILED", true);

            if (error.status === 401) {
              handleControlKeyRejected(pendingKind === "reset" ? "Reset" : "Save");
              return;
            }

            setStatusMessage(
              (pendingKind === "reset" ? "Reset" : "Save") + " failed after websocket drop: " + error.message,
              true
            );
          });
          return;
        }

        setStatusMessage("Realtime link lost. Reconnecting...", true);
      },
      onOpen: function onOpen() {
        setConnectionState("WS LIVE", false);

        if (!initialLoadComplete) {
          setStatusMessage("Connected directly to the Pi websocket.", false);
        }
      },
      onState: handleRealtimeState,
      onErrorMessage: handleRealtimeError,
    });
  }

  function handleAction(action) {
    const nextState = snapshotState();

    switch (action) {
      case "inning-down":
        nextState.inning = Math.max(1, nextState.inning - 1);
        break;
      case "inning-up":
        nextState.inning = Math.min(10, nextState.inning + 1);
        break;
      case "set-guest-at-bat":
        nextState.half = "top";
        break;
      case "set-home-at-bat":
        nextState.half = "bottom";
        break;
      case "next-half":
        nextHalf(nextState);
        break;
      case "ball-down":
        nextState.ball = Math.max(0, nextState.ball - 1);
        break;
      case "ball-up":
        if (nextState.ball >= 3) {
          clearBallStrikes(nextState);
        } else {
          nextState.ball += 1;
        }
        break;
      case "clear-ball-strikes":
        clearBallStrikes(nextState);
        break;
      case "strike-down":
        nextState.strike = Math.max(0, nextState.strike - 1);
        break;
      case "strike-up":
        if (nextState.strike >= 2) {
          recordOut(nextState);
        } else {
          nextState.strike += 1;
        }
        break;
      case "out-down":
        nextState.out = Math.max(0, nextState.out - 1);
        break;
      case "out-up":
        recordOut(nextState);
        break;
      case "current-runs-down":
        adjustCurrentBattingRuns(nextState, -1);
        break;
      case "current-runs-up":
        adjustCurrentBattingRuns(nextState, 1);
        break;
      case "toggle-blackout":
        nextState.blackout = !nextState.blackout;
        closeMenuPanel();
        break;
      default:
        return;
    }

    applyLocalState(nextState);
  }

  function restoreFromHistory(direction) {
    if (saveInFlight) {
      return;
    }

    const sourceStack = direction === "undo" ? undoStack : redoStack;
    const targetStack = direction === "undo" ? redoStack : undoStack;

    if (sourceStack.length === 0) {
      return;
    }

    targetStack.push(snapshotState());
    state = core.serializeState(sourceStack.pop());
    render();
    saveState();
  }

  function downloadBackup() {
    const backup = JSON.stringify(snapshotState(), null, 2);
    const blob = new Blob([backup], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = core.buildBackupFilename();
    link.click();
    URL.revokeObjectURL(url);
    setStatusMessage("Backup downloaded.", false);
  }

  function importBackup(file) {
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = function onLoad() {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        applyLocalState(core.serializeState(parsed));
      } catch (error) {
        setStatusMessage("Import failed: invalid JSON backup.", true);
      }
    };
    reader.readAsText(file);
  }

  function saveControlKey() {
    const value = controlKeyInput.value.trim();

    if (!value) {
      if (config.requireKey) {
        setStatusMessage("Enter the control password to continue.", true);
        controlKeyInput.focus();
        return;
      }

      setStatusMessage("Enter a control password or tap Skip.", true);
      return;
    }

    core.setControlKey(value);
    controlKeyInput.value = "";
    authDismissed = false;
    render();
    setStatusMessage("Control password saved in this browser.", false);
  }

  async function runSystemAction(actionName, actionLabel, confirmationMessage, connectionLabel) {
    const confirmed = window.confirm(confirmationMessage);

    if (!confirmed) {
      return;
    }

    if (config.requireKey && !core.getControlKey()) {
      authDismissed = false;
      render();
      setStatusMessage("Enter the control password to use system controls.", true);
      return;
    }

    try {
      const payload = await core.runSystemAction(actionName);
      setConnectionState(connectionLabel, true);
      setStatusMessage(payload.message || actionLabel + " requested.", false);
      closeMenuPanel();
    } catch (error) {
      if (error.status === 401) {
        handleControlKeyRejected(actionLabel);
      } else {
        setStatusMessage(actionLabel + " failed: " + error.message, true);
      }
    }
  }

  document.addEventListener("click", function onDocumentClick(event) {
    const actionTrigger = event.target.closest("[data-action]");
    const closeOverlayTrigger = event.target.closest("[data-close-overlay]");

    if (actionTrigger) {
      handleAction(actionTrigger.dataset.action);
      return;
    }

    if (closeOverlayTrigger) {
      toggleOverlay(document.getElementById(closeOverlayTrigger.dataset.closeOverlay), false);
    }
  });

  inningEditor.addEventListener("change", function onInputChange(event) {
    const target = event.target;

    if (!target.classList.contains("inning-input")) {
      return;
    }

    const nextState = snapshotState();
    const index = Number.parseInt(target.dataset.index, 10);
    const team = target.dataset.team;
    const value = Math.max(0, Number.parseInt(target.value || "0", 10) || 0);

    if (team === "guest") {
      nextState.guest_runs[index] = value;
    } else {
      nextState.home_runs[index] = value;
    }

    applyLocalState(nextState);
  });

  if (designSelect) {
    designSelect.addEventListener("change", function onDesignChange() {
      const nextState = snapshotState();
      nextState.design_id = designSelect.value;
      applyLocalState(nextState);
    });
  }

  designOptions.forEach(function bindDesignOption(option, index) {
    option.addEventListener("click", function onDesignOptionClick() {
      commitDesignSelection(option.dataset.value);
    });

    option.addEventListener("keydown", function onDesignOptionKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        navigateMenuBack();

        if (menuBackButton) {
          menuBackButton.focus();
        }
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        commitDesignSelection(option.dataset.value);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        designOptions[Math.min(index + 1, designOptions.length - 1)].focus();
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        designOptions[Math.max(index - 1, 0)].focus();
      }
    });
  });

  wifiFallbackOptions.forEach(function bindWifiFallbackOption(option, index) {
    option.addEventListener("click", function onWifiFallbackClick() {
      commitWifiFallbackSelection(option.dataset.value);
    });

    option.addEventListener("keydown", function onWifiFallbackKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        navigateMenuBack();

        if (menuBackButton) {
          menuBackButton.focus();
        }
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        commitWifiFallbackSelection(option.dataset.value);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        wifiFallbackOptions[Math.min(index + 1, wifiFallbackOptions.length - 1)].focus();
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        wifiFallbackOptions[Math.max(index - 1, 0)].focus();
      }
    });
  });

  wifiGraceOptions.forEach(function bindWifiGraceOption(option, index) {
    option.addEventListener("click", function onWifiGraceClick() {
      commitWifiGraceSelection(option.dataset.value);
    });

    option.addEventListener("keydown", function onWifiGraceKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        navigateMenuBack();

        if (menuBackButton) {
          menuBackButton.focus();
        }
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        commitWifiGraceSelection(option.dataset.value);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        wifiGraceOptions[Math.min(index + 1, wifiGraceOptions.length - 1)].focus();
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        wifiGraceOptions[Math.max(index - 1, 0)].focus();
      }
    });
  });

  displayIdleOptions.forEach(function bindDisplayIdleOption(option, index) {
    option.addEventListener("click", function onDisplayIdleClick() {
      commitDisplayIdleSelection(option.dataset.value);
    });

    option.addEventListener("keydown", function onDisplayIdleKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        navigateMenuBack();

        if (menuBackButton) {
          menuBackButton.focus();
        }
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        commitDisplayIdleSelection(option.dataset.value);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        displayIdleOptions[Math.min(index + 1, displayIdleOptions.length - 1)].focus();
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        displayIdleOptions[Math.max(index - 1, 0)].focus();
      }
    });
  });

  displayBlackoutOptions.forEach(function bindDisplayBlackoutOption(option, index) {
    option.addEventListener("click", function onDisplayBlackoutClick() {
      commitDisplayBlackoutSelection(option.dataset.value);
    });

    option.addEventListener("keydown", function onDisplayBlackoutKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        navigateMenuBack();

        if (menuBackButton) {
          menuBackButton.focus();
        }
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        commitDisplayBlackoutSelection(option.dataset.value);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        displayBlackoutOptions[Math.min(index + 1, displayBlackoutOptions.length - 1)].focus();
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        displayBlackoutOptions[Math.max(index - 1, 0)].focus();
      }
    });
  });

  undoButton.addEventListener("click", function onUndo() {
    restoreFromHistory("undo");
  });
  redoButton.addEventListener("click", function onRedo() {
    restoreFromHistory("redo");
  });

  menuButton.addEventListener("click", function toggleMenu() {
    if (menuPanel.hidden) {
      openMenuPanel();
    } else {
      closeMenuPanel();
    }
  });

  if (powerButton) {
    powerButton.addEventListener("click", handlePowerClick);
  }

  if (menuBackButton) {
    menuBackButton.addEventListener("click", navigateMenuBack);
  }

  if (menuCloseButton) {
    menuCloseButton.addEventListener("click", closeMenuPanel);
  }

  if (menuPanelBackdrop) {
    menuPanelBackdrop.addEventListener("click", closeMenuPanel);
  }

  if (menuPanel) {
    menuPanel.addEventListener("click", function onMenuPanelClick(event) {
      const navigateTrigger = event.target.closest("[data-navigate-menu]");
      const openOverlayTrigger = event.target.closest("[data-open-overlay]");

      if (navigateTrigger) {
        navigateMenuForward(navigateTrigger.dataset.navigateMenu);
        return;
      }

      if (openOverlayTrigger) {
        closeMenuPanel();
        toggleOverlay(document.getElementById(openOverlayTrigger.dataset.openOverlay), true);
      }
    });
  }

  if (inningEditOverlay) {
    inningEditOverlay.addEventListener("click", function onInningEditBackdrop(event) {
      if (event.target === inningEditOverlay) {
        toggleOverlay(inningEditOverlay, false);
      }
    });
  }

  logoutButton.addEventListener("click", function onLogout() {
    core.setControlKey("");
    controlKeyInput.value = "";
    authDismissed = false;
    closeMenuPanel();
    toggleOverlay(inningEditOverlay, false);
    render();
    setStatusMessage("Stored control password cleared.", false);
  });

  saveKeyButton.addEventListener("click", saveControlKey);
  controlKeyInput.addEventListener("keydown", function onKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      saveControlKey();
    }
  });

  authSkipButton.addEventListener("click", function onSkip() {
    authDismissed = true;
    controlKeyInput.value = "";
    render();
    setStatusMessage("Control password skipped for this session.", false);
  });

  document.getElementById("download-backup-button").addEventListener("click", downloadBackup);
  document.getElementById("import-backup-button").addEventListener("click", function chooseBackup() {
    backupFileInput.click();
  });
  backupFileInput.addEventListener("change", function onFileChange() {
    importBackup(backupFileInput.files[0]);
    backupFileInput.value = "";
  });

  document.getElementById("reset-game-button").addEventListener("click", async function onReset() {
    const confirmed = window.confirm("Reset the entire game and clear every inning?");

    if (!confirmed) {
      return;
    }

    if (config.requireKey && !core.getControlKey()) {
      authDismissed = false;
      render();
      setStatusMessage("Enter the control password to reset the game.", true);
      return;
    }

    pushUndoState(snapshotState());

    const requestId = nextRequestId();
    const realtimeSent =
      realtime &&
      realtime.send({
        type: "reset_state",
        request_id: requestId,
        control_key: core.getControlKey(),
      });

    if (realtimeSent) {
      saveInFlight = true;
      updateHistoryButtons();
      pendingRequestId = requestId;
      pendingActionType = "reset";
      setStatusMessage("Resetting game...", false);
      return;
    }

    try {
      await resetStateOverHttp();
      saveInFlight = false;
      render();
    } catch (error) {
      undoStack.pop();
      redoStack = [];
      updateHistoryButtons();
      pendingRequestId = "";
      pendingActionType = "";
      saveInFlight = false;

      if (error.status === 401) {
        handleControlKeyRejected("Reset");
      } else {
        setStatusMessage("Reset failed: " + error.message, true);
      }
    }
  });

  restartSystemButton.addEventListener("click", function onRestartSystem() {
    runSystemAction(
      "restart-scoreboard",
      "Restart Application",
      "Restart the scoreboard application and display now? The controller may disconnect for a moment.",
      "APPLICATION RESTARTING"
    );
  });

  rebootPiButton.addEventListener("click", function onRebootPi() {
    runSystemAction(
      "reboot-pi",
      "Reboot Raspberry Pi",
      "Reboot the scoreboard now? This restarts the Raspberry Pi and disconnects all controllers until boot finishes.",
      "SCOREBOARD REBOOTING"
    );
  });

  shutdownPiButton.addEventListener("click", function onShutdownPi() {
    runSystemAction(
      "shutdown-pi",
      "Shutdown Raspberry Pi",
      "Shut down the scoreboard now? This powers off the Raspberry Pi, and you will need to turn it back on manually.",
      "SCOREBOARD SHUTDOWN"
    );
  });

  buildInningEditor();
  closeMenuPanel();
  updateHistoryButtons();
  render();
  refreshDisplayIdleSettingsSilently();
  loadState();
  connectRealtime();
  window.setInterval(syncPowerButton, 10000);
  window.setInterval(refreshDisplayIdleSettingsSilently, 60000);
})();
