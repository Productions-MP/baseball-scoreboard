(function runDisplayPage() {
  if (!window.ScoreboardCore) {
    return;
  }

  const core = window.ScoreboardCore;
  const POLL_INTERVAL_MS = 2000;
  const DESIGN_WIDTH = 768;
  const DESIGN_HEIGHT = 192;

  const frame = document.getElementById("display-frame");
  const modePill = document.getElementById("mode-pill");
  const connectionPill = document.getElementById("connection-pill");
  const updatedAt = document.getElementById("updated-at");
  const gameStatus = document.getElementById("game-status");
  const balls = document.getElementById("count-balls");
  const strikes = document.getElementById("count-strikes");
  const outs = document.getElementById("count-outs");
  const guestTotal = document.getElementById("guest-total");
  const homeTotal = document.getElementById("home-total");

  function setScale() {
    const scale = Math.min(window.innerWidth / DESIGN_WIDTH, window.innerHeight / DESIGN_HEIGHT);
    frame.style.transform = "scale(" + Math.max(scale, 0.1) + ")";
  }

  function setCell(id, value) {
    const element = document.getElementById(id);

    if (element) {
      element.textContent = String(value);
    }
  }

  function render(statePayload) {
    const state = core.withDerived(statePayload.state || statePayload);
    const halfLabel = state.half === "bottom" ? "BOTTOM" : "TOP";
    const savedLabel = statePayload.updated_at || state.updated_at;

    state.guest_runs.forEach(function renderGuest(run, index) {
      setCell("guest-run-" + index, run);
    });

    state.home_runs.forEach(function renderHome(run, index) {
      setCell("home-run-" + index, run);
    });

    guestTotal.textContent = String(state.guest_total);
    homeTotal.textContent = String(state.home_total);
    balls.textContent = String(state.balls);
    strikes.textContent = String(state.strikes);
    outs.textContent = String(state.outs);
    gameStatus.textContent = halfLabel + " " + state.inning;
    modePill.textContent = (window.SCOREBOARD_CONFIG.modeLabel || "Mode").toUpperCase();
    updatedAt.textContent = savedLabel ? "Saved " + core.formatTimestamp(savedLabel) : "Waiting for first save";
  }

  async function refresh() {
    try {
      const payload = await core.fetchState();
      render(payload);
      connectionPill.textContent = "LIVE";
      connectionPill.classList.remove("is-offline");
    } catch (error) {
      connectionPill.textContent = "RETRYING";
      connectionPill.classList.add("is-offline");
      updatedAt.textContent = "Waiting to reconnect";
    }
  }

  window.addEventListener("resize", setScale);
  setScale();
  refresh();
  window.setInterval(refresh, POLL_INTERVAL_MS);
})();
