(function runControlPage() {
  if (!window.ScoreboardCore) {
    return;
  }

  const core = window.ScoreboardCore;
  const config = core.getConfig();
  const HISTORY_LIMIT = 150;

  const undoButton = document.getElementById("undo-button");
  const redoButton = document.getElementById("redo-button");
  const menuButton = document.getElementById("menu-button");
  const menuPopover = document.getElementById("menu-popover");
  const openUtilitiesButton = document.getElementById("open-utilities-button");
  const closeUtilitiesButton = document.getElementById("close-utilities-button");
  const logoutButton = document.getElementById("logout-button");
  const utilitiesOverlay = document.getElementById("utilities-overlay");
  const authOverlay = document.getElementById("auth-overlay");
  const authNote = document.getElementById("auth-note");
  const authSkipButton = document.getElementById("auth-skip-button");
  const controlKeyInput = document.getElementById("control-key-input");
  const saveKeyButton = document.getElementById("save-key-button");
  const liveInningLabel = document.getElementById("live-inning-label");
  const ballValue = document.getElementById("ball-value");
  const strikeValue = document.getElementById("strike-value");
  const outValue = document.getElementById("out-value");
  const currentRunsValue = document.getElementById("current-runs-value");
  const outChip = document.getElementById("out-chip");
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

  let state = core.cloneDefaultState();
  let saveInFlight = false;
  let pendingRequestId = "";
  let pendingActionType = "";
  let realtime = null;
  let initialLoadComplete = false;
  let authDismissed = false;
  let undoStack = [];
  let redoStack = [];

  function setStatusMessage(message, isError) {
    saveNote.textContent = message;
    saveNote.classList.toggle("is-error", Boolean(isError));
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
    const normalizedNext = core.serializeState(nextState);

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
    element.hidden = !isVisible;
  }

  function closeMenu() {
    menuPopover.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
  }

  function openUtilities() {
    closeMenu();
    toggleOverlay(utilitiesOverlay, true);
  }

  function closeUtilities() {
    toggleOverlay(utilitiesOverlay, false);
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
    outChip.textContent = "Outs " + derived.out;

    guestBatButton.classList.toggle("is-active", guestBatting);
    homeBatButton.classList.toggle("is-active", !guestBatting);
    guestBatArrow.classList.toggle("is-active", guestBatting);
    homeBatArrow.classList.toggle("is-active", !guestBatting);
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
    syncEditorInputs();
    updateAuthOverlay();
    updateHistoryButtons();
  }

  function replaceState(nextState, options) {
    state = core.serializeState(nextState);

    if (!options || !options.preserveHistory) {
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
    state = core.serializeState(payload.state);
    render();
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
    state = core.serializeState(payload.state);
    render();
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
    state = core.serializeState(payload.state);
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
      render();
      setStatusMessage(
        completedAction === "reset" ? "Game reset complete." : "Saved " + core.formatTimestamp(payload.updated_at || payload.state.updated_at),
        false
      );
      return;
    }

    clearHistory();
    render();
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
      closeUtilities();
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

    if (actionTrigger) {
      handleAction(actionTrigger.dataset.action);
      return;
    }

    if (!menuPopover.hidden && !event.target.closest("#menu-popover") && !event.target.closest("#menu-button")) {
      closeMenu();
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

  undoButton.addEventListener("click", function onUndo() {
    restoreFromHistory("undo");
  });
  redoButton.addEventListener("click", function onRedo() {
    restoreFromHistory("redo");
  });

  menuButton.addEventListener("click", function toggleMenu() {
    const isOpening = menuPopover.hidden;
    menuPopover.hidden = !isOpening;
    menuButton.setAttribute("aria-expanded", String(isOpening));
  });

  openUtilitiesButton.addEventListener("click", openUtilities);
  closeUtilitiesButton.addEventListener("click", closeUtilities);
  utilitiesOverlay.addEventListener("click", function onUtilitiesBackdrop(event) {
    if (event.target === utilitiesOverlay) {
      closeUtilities();
    }
  });

  logoutButton.addEventListener("click", function onLogout() {
    core.setControlKey("");
    controlKeyInput.value = "";
    authDismissed = false;
    closeMenu();
    closeUtilities();
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
      "Reboot Scoreboard",
      "Reboot the scoreboard now? This restarts the Raspberry Pi and disconnects all controllers until boot finishes.",
      "SCOREBOARD REBOOTING"
    );
  });

  shutdownPiButton.addEventListener("click", function onShutdownPi() {
    runSystemAction(
      "shutdown-pi",
      "Shutdown Scoreboard",
      "Shut down the scoreboard now? This powers off the Raspberry Pi, and you will need to turn it back on manually.",
      "SCOREBOARD SHUTDOWN"
    );
  });

  buildInningEditor();
  closeMenu();
  updateHistoryButtons();
  render();
  loadState();
  connectRealtime();
})();
