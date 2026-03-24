(function runDisplayPage() {
  if (!window.ScoreboardCore) {
    return;
  }

  const core = window.ScoreboardCore;
  const config = core.getConfig();
  const activeDesign = core.getActiveDesign();
  const frame = document.getElementById("display-frame");
  const heartbeatLed = document.getElementById("heartbeat-led");
  let realtime = null;
  let latestState = null;
  let reloadingForDesignChange = false;

  function hideCursor() {
    if (document.documentElement) {
      document.documentElement.style.cursor = "none";
    }

    if (document.body) {
      document.body.style.cursor = "none";
    }
  }

  function setScale() {
    const scale = Math.min(window.innerWidth / activeDesign.width, window.innerHeight / activeDesign.height);
    const safeScale = Math.max(scale, 0.1);
    const offsetX = Math.max((window.innerWidth - activeDesign.width * safeScale) / 2, 0);
    const offsetY = Math.max((window.innerHeight - activeDesign.height * safeScale) / 2, 0);

    frame.style.transform = "translate(" + offsetX + "px, " + offsetY + "px) scale(" + safeScale + ")";
  }

  function setWsLive(isLive) {
    if (!heartbeatLed) {
      return;
    }

    heartbeatLed.classList.toggle("is-live", isLive);
    heartbeatLed.classList.toggle("is-offline", !isLive);
  }

  function reloadForDesignChange() {
    if (reloadingForDesignChange) {
      return;
    }

    reloadingForDesignChange = true;
    setWsLive(false);
    window.location.reload();
  }

  function createBaseballLinescoreRenderer(root, options) {
    const settings = options || {};
    const activeInningHighlight = document.getElementById("active-inning-highlight");
    const guestTeamCell = document.getElementById("guest-team-cell");
    const homeTeamCell = document.getElementById("home-team-cell");
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
      const highlightParent = activeInningHighlight ? activeInningHighlight.parentElement : null;
      const topInset = 0;
      const stroke = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--linescore-stroke")
      ) || 0;
      const horizontalInset = Math.max(stroke - 1, 0);
      const verticalInset = Math.max(stroke - 1, 0);

      if (!activeInningHighlight || !headCell || !bottomCell) {
        if (activeInningHighlight) {
          activeInningHighlight.style.opacity = "0";
        }

        return;
      }

      activeInningHighlight.style.opacity = "1";
      if (settings.activeInningStyle === "full-column" && highlightParent) {
        activeInningHighlight.style.left = headCell.offsetLeft - horizontalInset + "px";
        activeInningHighlight.style.top = "0px";
        activeInningHighlight.style.width = headCell.offsetWidth + horizontalInset + "px";
        activeInningHighlight.style.height = Math.max(0, highlightParent.offsetHeight) + "px";
        return;
      }

      activeInningHighlight.style.left = headCell.offsetLeft - horizontalInset + "px";
      activeInningHighlight.style.top =
        (settings.fullHeightActiveInning && highlightParent ? -verticalInset : headCell.offsetTop + topInset) + "px";
      activeInningHighlight.style.width = headCell.offsetWidth + horizontalInset + "px";
      activeInningHighlight.style.height =
        (
          settings.fullHeightActiveInning && highlightParent
            ? Math.max(0, highlightParent.offsetHeight + verticalInset * 2)
            : Math.max(0, bottomCell.offsetTop + bottomCell.offsetHeight - headCell.offsetTop - topInset)
        ) + "px";
    }

    function shouldHideRun(run, index, state) {
      return settings.hideFutureInnings && index + 1 > state.inning && Number(run) <= 0;
    }

    return {
      render: function render(state) {
        const hasOvertime =
          state.inning >= 10 ||
          (Array.isArray(state.guest_runs) && Number(state.guest_runs[9]) > 0) ||
          (Array.isArray(state.home_runs) && Number(state.home_runs[9]) > 0);

        state.guest_runs.forEach(function renderGuest(run, index) {
          const shouldHideFutureInning = shouldHideRun(run, index, state);
          setCell("guest-run-" + index, shouldHideFutureInning ? "" : run);
        });

        state.home_runs.forEach(function renderHome(run, index) {
          const shouldHideFutureInning = shouldHideRun(run, index, state);
          setCell("home-run-" + index, shouldHideFutureInning ? "" : run);
        });

        if (guestTotal) {
          guestTotal.textContent = String(state.guest_total);
        }

        if (homeTotal) {
          homeTotal.textContent = String(state.home_total);
        }

        if (ball) {
          ball.textContent = String(state.ball);
        }

        if (strike) {
          strike.textContent = String(state.strike);
        }

        if (out) {
          out.textContent = String(state.out);
        }

        if (guestArrow) {
          guestArrow.classList.toggle("is-active", state.half !== "bottom");
        }

        if (homeArrow) {
          homeArrow.classList.toggle("is-active", state.half === "bottom");
        }

        if (guestTeamCell) {
          guestTeamCell.classList.toggle("is-at-bat", state.half !== "bottom");
        }

        if (homeTeamCell) {
          homeTeamCell.classList.toggle("is-at-bat", state.half === "bottom");
        }

        if (root) {
          root.classList.toggle("has-overtime", hasOvertime);
        }

        overtimeCells.forEach(function toggleOvertimeCell(cell) {
          if (cell) {
            cell.classList.toggle("is-overtime-active", hasOvertime);
          }
        });

        updateActiveInningHighlight(state);
      },
      resize: function resize(state) {
        if (state) {
          updateActiveInningHighlight(state);
        }
      },
    };
  }

  const displayRenderers = {
    "baseball-v1": function createBaseballV1Renderer() {
      return createBaseballLinescoreRenderer(document.querySelector(".scoreboard-display-baseball-v1"));
    },
    "baseball-v2": function createBaseballV2Renderer() {
      return createBaseballLinescoreRenderer(document.querySelector(".scoreboard-display-baseball-v2"), {
        activeInningStyle: "full-column",
        fullHeightActiveInning: true,
        hideFutureInnings: true,
      });
    },
  };

  const rendererFactory = displayRenderers[activeDesign.id];

  if (!rendererFactory) {
    return;
  }

  const renderer = rendererFactory();

  function render(payload) {
    const state = core.withDerived(payload.state || payload);

    if (state.design_id !== activeDesign.id) {
      reloadForDesignChange();
      return;
    }

    latestState = state;
    renderer.render(state);
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
    renderer.resize(latestState);
  });
  window.addEventListener("mousemove", hideCursor, { passive: true });
  window.addEventListener("pointermove", hideCursor, { passive: true });
  document.addEventListener("visibilitychange", hideCursor);
  hideCursor();
  setScale();
  if (config.initialState) {
    render(config.initialState);
  }
  refresh();
  connectRealtime();
})();
