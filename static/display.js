(function runDisplayPage() {
  if (!window.ScoreboardCore) {
    return;
  }

  const core = window.ScoreboardCore;
  const DESIGN_WIDTH = 768;
  const DESIGN_HEIGHT = 192;
  let realtime = null;
  let latestState = null;

  const frame = document.getElementById("display-frame");
  const heartbeatLed = document.getElementById("heartbeat-led");
  const activeInningHighlight = document.getElementById("active-inning-highlight");
  const guestArrow = document.getElementById("guest-arrow");
  const homeArrow = document.getElementById("home-arrow");
  const ball = document.getElementById("count-ball");
  const strike = document.getElementById("count-strike");
  const out = document.getElementById("count-out");
  const guestTotal = document.getElementById("guest-total");
  const homeTotal = document.getElementById("home-total");
  const overtimeCells = [
    document.getElementById("inning-head-9"),
    document.getElementById("guest-run-9"),
    document.getElementById("home-run-9"),
  ];

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

  function updateActiveInningHighlight(state) {
    const inningIndex = Math.max(0, Math.min(9, state.inning - 1));
    const headCell = document.getElementById("inning-head-" + inningIndex);
    const bottomCell = document.getElementById("home-run-" + inningIndex);
    const topInset = 0;
    const stroke = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--linescore-stroke")
    ) || 0;
    const horizontalInset = Math.max(stroke - 1, 0);

    if (!headCell || !bottomCell) {
      activeInningHighlight.style.opacity = "0";
      return;
    }

    activeInningHighlight.style.opacity = "1";
    activeInningHighlight.style.left = headCell.offsetLeft - horizontalInset + "px";
    activeInningHighlight.style.top = headCell.offsetTop + topInset + "px";
    activeInningHighlight.style.width = headCell.offsetWidth + horizontalInset + "px";
    activeInningHighlight.style.height =
      Math.max(0, bottomCell.offsetTop + bottomCell.offsetHeight - headCell.offsetTop - topInset) + "px";
  }

  function render(statePayload) {
    const state = core.withDerived(statePayload.state || statePayload);
    latestState = state;

    state.guest_runs.forEach(function renderGuest(run, index) {
      setCell("guest-run-" + index, run);
    });

    state.home_runs.forEach(function renderHome(run, index) {
      setCell("home-run-" + index, run);
    });

    guestTotal.textContent = String(state.guest_total);
    homeTotal.textContent = String(state.home_total);
    ball.textContent = String(state.ball);
    strike.textContent = String(state.strike);
    out.textContent = String(state.out);
    guestArrow.classList.toggle("is-active", state.half !== "bottom");
    homeArrow.classList.toggle("is-active", state.half === "bottom");
    overtimeCells.forEach(function toggleOvertimeCell(cell) {
      if (cell) {
        cell.classList.toggle("is-overtime-active", state.inning >= 10);
      }
    });
    updateActiveInningHighlight(state);
  }

  function setWsLive(isLive) {
    heartbeatLed.classList.toggle("is-live", isLive);
    heartbeatLed.classList.toggle("is-offline", !isLive);
  }

  async function refresh() {
    try {
      const payload = await core.fetchState();
      render(payload);
      setWsLive(false);
    } catch (error) {
      setWsLive(false);
    }
  }

  function connectRealtime() {
    realtime = core.createRealtimeChannel({
      onClose: function onClose() {
        setWsLive(false);
      },
      onOpen: function onOpen() {
        setWsLive(true);
      },
      onState: function onState(payload) {
        render(payload);
        setWsLive(true);
      },
    });
  }

  window.addEventListener("resize", function onResize() {
    setScale();
    if (latestState) {
      updateActiveInningHighlight(latestState);
    }
  });
  setScale();
  refresh();
  connectRealtime();
})();
