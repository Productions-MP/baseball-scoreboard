(function runControlPage() {
  if (!window.ScoreboardCore) {
    return;
  }

  const core = window.ScoreboardCore;
  const config = core.getConfig();
  const POLL_INTERVAL_MS = 5000;

  const summaryText = document.getElementById("summary-text");
  const modeLabel = document.getElementById("mode-label");
  const networkLabel = document.getElementById("network-label");
  const lastSaved = document.getElementById("last-saved");
  const authPanel = document.getElementById("auth-panel");
  const authNote = document.getElementById("auth-note");
  const controlKeyInput = document.getElementById("control-key-input");
  const ballsValue = document.getElementById("balls-value");
  const strikesValue = document.getElementById("strikes-value");
  const outsValue = document.getElementById("outs-value");
  const liveInningChip = document.getElementById("live-inning-chip");
  const liveScoreChip = document.getElementById("live-score-chip");
  const guestCurrentInning = document.getElementById("guest-current-inning");
  const homeCurrentInning = document.getElementById("home-current-inning");
  const inningEditor = document.getElementById("inning-editor");
  const saveNote = document.getElementById("save-note");
  const backupFileInput = document.getElementById("backup-file-input");

  let state = core.cloneDefaultState();
  let saveInFlight = false;

  function setStatusMessage(message, isError) {
    saveNote.textContent = message;
    saveNote.classList.toggle("is-error", Boolean(isError));
  }

  function currentInningIndex() {
    return Math.max(0, Math.min(9, state.inning - 1));
  }

  function updateSummary() {
    const derived = core.withDerived(state);
    const halfLabel = derived.half === "bottom" ? "BOTTOM" : "TOP";

    modeLabel.textContent = (config.modeLabel || "Mode").toUpperCase();
    summaryText.textContent = halfLabel + " " + derived.inning + " | GUEST " + derived.guest_total + " - HOME " + derived.home_total;
    liveInningChip.textContent = halfLabel + " " + derived.inning;
    liveScoreChip.textContent = "GUEST " + derived.guest_total + " | HOME " + derived.home_total;
    ballsValue.textContent = String(derived.balls);
    strikesValue.textContent = String(derived.strikes);
    outsValue.textContent = String(derived.outs);
    guestCurrentInning.textContent = String(derived.guest_runs[currentInningIndex()]);
    homeCurrentInning.textContent = String(derived.home_runs[currentInningIndex()]);
    lastSaved.textContent = core.formatTimestamp(derived.updated_at);
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
    authPanel.classList.toggle("is-auth-required", Boolean(config.requireKey));
    authNote.textContent = core.getControlKey()
      ? "A control key is stored in this browser."
      : "A saved key is required before write actions will succeed.";
  }

  function replaceState(nextState) {
    state = core.withDerived(nextState);
    render();
  }

  async function saveState() {
    if (saveInFlight) {
      return;
    }

    saveInFlight = true;
    setStatusMessage("Saving...", false);

    try {
      const payload = await core.updateState(state);
      replaceState(payload.state);
      networkLabel.textContent = "ONLINE";
      networkLabel.classList.remove("is-offline");
      setStatusMessage("Saved " + core.formatTimestamp(payload.updated_at || payload.state.updated_at), false);
    } catch (error) {
      networkLabel.textContent = "SAVE FAILED";
      networkLabel.classList.add("is-offline");
      if (error.status === 401) {
        setStatusMessage("Save failed: control key rejected.", true);
      } else {
        setStatusMessage("Save failed: " + error.message, true);
      }
    } finally {
      saveInFlight = false;
      render();
    }
  }

  async function loadState() {
    try {
      const payload = await core.fetchState();
      replaceState(payload.state);
      networkLabel.textContent = "ONLINE";
      networkLabel.classList.remove("is-offline");
      setStatusMessage("Connected to " + config.modeLabel.toLowerCase() + ".", false);
    } catch (error) {
      networkLabel.textContent = "OFFLINE";
      networkLabel.classList.add("is-offline");
      setStatusMessage("Unable to reach the scoreboard API right now.", true);
    }
  }

  function clearBallsStrikes() {
    state.balls = 0;
    state.strikes = 0;
  }

  function clearCount() {
    clearBallsStrikes();
    state.outs = 0;
  }

  function nextHalf() {
    if (state.half === "top") {
      state.half = "bottom";
    } else {
      state.half = "top";
      state.inning = Math.min(10, state.inning + 1);
    }

    clearCount();
  }

  function adjustCurrentInning(team, delta) {
    const index = currentInningIndex();
    const key = team === "guest" ? "guest_runs" : "home_runs";
    state[key][index] = Math.max(0, state[key][index] + delta);
  }

  function handleAction(action) {
    switch (action) {
      case "inning-down":
        state.inning = Math.max(1, state.inning - 1);
        break;
      case "inning-up":
        state.inning = Math.min(10, state.inning + 1);
        break;
      case "set-top":
        state.half = "top";
        break;
      case "set-bottom":
        state.half = "bottom";
        break;
      case "next-half":
        nextHalf();
        break;
      case "balls-down":
        state.balls = Math.max(0, state.balls - 1);
        break;
      case "balls-up":
        state.balls = Math.min(3, state.balls + 1);
        break;
      case "strikes-down":
        state.strikes = Math.max(0, state.strikes - 1);
        break;
      case "strikes-up":
        state.strikes = Math.min(2, state.strikes + 1);
        break;
      case "outs-down":
        state.outs = Math.max(0, state.outs - 1);
        break;
      case "outs-up":
        state.outs = Math.min(2, state.outs + 1);
        break;
      case "clear-balls-strikes":
        clearBallsStrikes();
        break;
      case "clear-count":
        clearCount();
        break;
      case "guest-current-down":
        adjustCurrentInning("guest", -1);
        break;
      case "guest-current-up":
        adjustCurrentInning("guest", 1);
        break;
      case "home-current-down":
        adjustCurrentInning("home", -1);
        break;
      case "home-current-up":
        adjustCurrentInning("home", 1);
        break;
      default:
        return;
    }

    render();
    saveState();
  }

  function downloadBackup() {
    const backup = JSON.stringify(core.serializeState(state), null, 2);
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
        state = core.serializeState(parsed);
        render();
        saveState();
      } catch (error) {
        setStatusMessage("Import failed: invalid JSON backup.", true);
      }
    };
    reader.readAsText(file);
  }

  document.addEventListener("click", function onClick(event) {
    const action = event.target && event.target.dataset ? event.target.dataset.action : "";

    if (action) {
      handleAction(action);
    }
  });

  inningEditor.addEventListener("change", function onInputChange(event) {
    const target = event.target;

    if (!target.classList.contains("inning-input")) {
      return;
    }

    const index = Number.parseInt(target.dataset.index, 10);
    const team = target.dataset.team;
    const value = Math.max(0, Number.parseInt(target.value || "0", 10) || 0);

    if (team === "guest") {
      state.guest_runs[index] = value;
    } else {
      state.home_runs[index] = value;
    }

    render();
    saveState();
  });

  document.getElementById("save-key-button").addEventListener("click", function saveKey() {
    core.setControlKey(controlKeyInput.value.trim());
    render();
    setStatusMessage("Control key saved in this browser.", false);
  });

  document.getElementById("clear-key-button").addEventListener("click", function clearKey() {
    controlKeyInput.value = "";
    core.setControlKey("");
    render();
    setStatusMessage("Stored control key cleared.", false);
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

    try {
      const payload = await core.resetState();
      replaceState(payload.state);
      networkLabel.textContent = "ONLINE";
      networkLabel.classList.remove("is-offline");
      setStatusMessage("Game reset complete.", false);
    } catch (error) {
      setStatusMessage("Reset failed: " + error.message, true);
    }
  });

  buildInningEditor();
  controlKeyInput.value = core.getControlKey();
  render();
  loadState();
  window.setInterval(loadState, POLL_INTERVAL_MS);
})();
