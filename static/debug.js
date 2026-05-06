(function runDebugPage() {
  const config = window.SCOREHLS_DEBUG_CONFIG || {};
  const endpoint = config.endpoint || "/api/debug/system";
  const pollMs = Math.max(15000, Number(config.sampleIntervalSeconds || 60) * 1000);

  const rangeSelect = document.getElementById("debug-range-select");
  const refreshButton = document.getElementById("debug-refresh-button");
  const rangeTitle = document.getElementById("debug-range-title");
  const chart = document.getElementById("debug-chart");
  const eventList = document.getElementById("debug-event-list");
  const eventCount = document.getElementById("debug-event-count");
  const deviceList = document.getElementById("debug-device-list");
  const usbCount = document.getElementById("debug-usb-count");
  const footnote = document.getElementById("debug-footnote");
  const statusCards = {
    power: document.querySelector('[data-debug-status-card="power"]'),
    usb: document.querySelector('[data-debug-status-card="usb"]'),
    wlan1: document.querySelector('[data-debug-status-card="wlan1"]'),
    wlan0: document.querySelector('[data-debug-status-card="wlan0"]'),
  };
  const statusFields = {
    power: {
      value: document.getElementById("debug-power-status"),
      meta: document.getElementById("debug-power-meta"),
    },
    usb: {
      value: document.getElementById("debug-usb-status"),
      meta: document.getElementById("debug-usb-meta"),
    },
    wlan1: {
      value: document.getElementById("debug-wlan1-status"),
      meta: document.getElementById("debug-wlan1-meta"),
    },
    wlan0: {
      value: document.getElementById("debug-wlan0-status"),
      meta: document.getElementById("debug-wlan0-meta"),
    },
  };

  let lastPayload = null;
  let refreshTimer = 0;

  function parseTime(value) {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatTime(value) {
    const date = parseTime(value);

    if (!date) {
      return "--";
    }

    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function formatRange(hours) {
    if (hours < 24) {
      return "Past " + hours + " hour" + (hours === 1 ? "" : "s");
    }

    const days = Math.round(hours / 24);
    return "Past " + days + " day" + (days === 1 ? "" : "s");
  }

  function setCardState(key, stateName) {
    const card = statusCards[key];

    if (!card) {
      return;
    }

    card.classList.toggle("is-good", stateName === "good");
    card.classList.toggle("is-warn", stateName === "warn");
    card.classList.toggle("is-bad", stateName === "bad");
  }

  function setField(key, value, meta, stateName) {
    const field = statusFields[key];

    if (!field) {
      return;
    }

    field.value.textContent = value;
    field.meta.textContent = meta || "--";
    setCardState(key, stateName);
  }

  function radioMeta(radio) {
    if (!radio || !radio.present) {
      return "missing";
    }

    const pieces = [radio.operstate || "unknown"];

    if (radio.ssid) {
      pieces.push(radio.ssid);
    }

    if (Number.isFinite(radio.signal_dbm)) {
      pieces.push(radio.signal_dbm + " dBm");
    }

    return pieces.join(" / ");
  }

  function renderLatest(payload) {
    const latest = payload.latest;

    if (!latest) {
      setField("power", "No Data", "--", "warn");
      setField("usb", "No Data", config.usbRadioId || "--", "warn");
      setField("wlan1", "No Data", "--", "warn");
      setField("wlan0", "No Data", "--", "warn");
      return;
    }

    const power = latest.power || {};
    const usb = latest.usb || {};
    const radios = latest.radios || {};
    const wlan0 = radios.wlan0 || {};
    const wlan1 = radios.wlan1 || {};

    const voltageWarn = Boolean(power.undervoltage_now || power.throttled_now);
    const voltageSeen = Boolean(power.undervoltage_seen || power.throttled_seen);
    setField(
      "power",
      voltageWarn ? "Voltage Low" : voltageSeen ? "Flag Seen" : "Clean",
      (power.raw || "--") + " / " + formatTime(latest.sampled_at),
      voltageWarn ? "bad" : voltageSeen ? "warn" : "good"
    );
    setField(
      "usb",
      usb.radio_present ? "Present" : "Missing",
      usb.radio_id || config.usbRadioId || "--",
      usb.radio_present ? "good" : "bad"
    );
    setField("wlan1", wlan1.online ? "Online" : wlan1.present ? "Offline" : "Missing", radioMeta(wlan1), wlan1.online ? "good" : "bad");
    setField("wlan0", wlan0.online ? "Online" : wlan0.present ? "Offline" : "Missing", radioMeta(wlan0), wlan0.online ? "warn" : "good");
  }

  function sampleStatus(sample) {
    const status = sample.status || {};
    return {
      usb: Boolean(status.usb_radio_present),
      wlan1: Boolean(status.wlan1_online),
      wlan0: Boolean(status.wlan0_online),
      voltage: Boolean(status.undervoltage_now),
      external: Boolean(status.external_power_likely_lost),
    };
  }

  function drawChart(samples) {
    if (!chart) {
      return;
    }

    const context = chart.getContext("2d");
    const width = chart.width;
    const height = chart.height;
    const rows = [
      { key: "usb", label: "USB Radio", warn: false },
      { key: "wlan1", label: "wlan1", warn: false },
      { key: "wlan0", label: "wlan0", warn: true },
      { key: "voltage", label: "Undervoltage", warn: true, invert: true },
      { key: "external", label: "Power Signal", warn: true, invert: true },
    ];
    const padding = { left: 132, right: 24, top: 28, bottom: 44 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const rowHeight = plotHeight / rows.length;
    const now = Date.now();
    const selectedHours = Math.max(1, Number(rangeSelect && rangeSelect.value) || 24);
    const startMs = now - selectedHours * 60 * 60 * 1000;

    context.clearRect(0, 0, width, height);
    context.fillStyle = "#06111d";
    context.fillRect(0, 0, width, height);

    context.strokeStyle = "rgba(174, 145, 66, 0.2)";
    context.lineWidth = 1;
    context.font = "16px Consolas, Menlo, monospace";
    context.textBaseline = "middle";

    rows.forEach(function drawRow(row, rowIndex) {
      const y = padding.top + rowIndex * rowHeight;
      context.fillStyle = rowIndex % 2 === 0 ? "rgba(255,255,255,0.025)" : "rgba(255,255,255,0.01)";
      context.fillRect(padding.left, y, plotWidth, rowHeight - 1);
      context.fillStyle = "rgba(235, 228, 207, 0.82)";
      context.fillText(row.label, 18, y + rowHeight / 2);
    });

    context.strokeStyle = "rgba(174, 145, 66, 0.24)";
    context.beginPath();
    rows.forEach(function drawGridLine(_row, rowIndex) {
      const y = padding.top + rowIndex * rowHeight;
      context.moveTo(padding.left, y);
      context.lineTo(width - padding.right, y);
    });
    context.moveTo(padding.left, padding.top + plotHeight);
    context.lineTo(width - padding.right, padding.top + plotHeight);
    context.stroke();

    if (!samples.length) {
      context.fillStyle = "rgba(235, 228, 207, 0.62)";
      context.textAlign = "center";
      context.fillText("No samples in this range", padding.left + plotWidth / 2, padding.top + plotHeight / 2);
      context.textAlign = "left";
      return;
    }

    rows.forEach(function drawSegments(row, rowIndex) {
      const y = padding.top + rowIndex * rowHeight + 8;
      const segmentHeight = Math.max(12, rowHeight - 16);

      samples.forEach(function drawSample(sample, index) {
        const time = parseTime(sample.sampled_at);

        if (!time) {
          return;
        }

        const next = samples[index + 1];
        const nextTime = next ? parseTime(next.sampled_at) : null;
        const x1 = padding.left + ((time.getTime() - startMs) / (now - startMs)) * plotWidth;
        const x2 = nextTime
          ? padding.left + ((nextTime.getTime() - startMs) / (now - startMs)) * plotWidth
          : padding.left + plotWidth;
        const status = sampleStatus(sample);
        const rawValue = Boolean(status[row.key]);
        const isGood = row.invert ? !rawValue : rawValue;
        const color = isGood ? "rgba(0, 154, 73, 0.82)" : row.warn ? "rgba(174, 145, 66, 0.86)" : "rgba(200, 79, 63, 0.86)";

        context.fillStyle = color;
        context.fillRect(Math.max(padding.left, x1), y, Math.max(1, x2 - x1), segmentHeight);
      });
    });

    context.fillStyle = "rgba(235, 228, 207, 0.74)";
    context.textBaseline = "top";
    context.font = "14px Consolas, Menlo, monospace";
    context.fillText(formatTime(new Date(startMs).toISOString()), padding.left, height - padding.bottom + 14);
    context.textAlign = "right";
    context.fillText(formatTime(new Date(now).toISOString()), width - padding.right, height - padding.bottom + 14);
    context.textAlign = "left";
  }

  function describeChange(key, value) {
    const names = {
      usb: "USB radio",
      wlan1: "wlan1",
      wlan0: "wlan0",
      voltage: "undervoltage",
      external: "external power signal",
    };

    if (key === "voltage") {
      return value ? "Undervoltage flag active" : "Undervoltage flag cleared";
    }

    if (key === "external") {
      return value ? "External power likely lost" : "External power signal cleared";
    }

    return names[key] + " " + (value ? "online" : "offline");
  }

  function buildEvents(samples) {
    const events = [];
    let previous = null;

    samples.forEach(function inspectSample(sample) {
      const current = sampleStatus(sample);

      if (!previous) {
        previous = current;
        return;
      }

      Object.keys(current).forEach(function inspectKey(key) {
        if (current[key] === previous[key]) {
          return;
        }

        events.push({
          sampled_at: sample.sampled_at,
          label: describeChange(key, current[key]),
          key,
          active: current[key],
        });
      });

      previous = current;
    });

    return events.reverse().slice(0, 80);
  }

  function renderEvents(samples) {
    const events = buildEvents(samples);
    eventCount.textContent = events.length + " change" + (events.length === 1 ? "" : "s");
    eventList.innerHTML = "";

    if (!events.length) {
      const item = document.createElement("li");
      item.className = "debug-empty-item";
      item.textContent = "No changes in range";
      eventList.appendChild(item);
      return;
    }

    events.forEach(function renderEvent(event) {
      const item = document.createElement("li");
      item.className = "debug-event-item";
      item.innerHTML = "<strong></strong><span></span>";
      item.querySelector("strong").textContent = event.label;
      item.querySelector("span").textContent = formatTime(event.sampled_at);
      eventList.appendChild(item);
    });
  }

  function renderDevices(latest) {
    const devices = latest && latest.usb && Array.isArray(latest.usb.devices) ? latest.usb.devices : [];
    usbCount.textContent = devices.length + " found";
    deviceList.innerHTML = "";

    if (!devices.length) {
      const item = document.createElement("li");
      item.className = "debug-empty-item";
      item.textContent = "No USB devices reported";
      deviceList.appendChild(item);
      return;
    }

    devices.forEach(function renderDevice(device) {
      const item = document.createElement("li");
      item.className = device.id === config.usbRadioId ? "debug-device-item is-target" : "debug-device-item";
      item.innerHTML = "<strong></strong><span></span>";
      item.querySelector("strong").textContent = device.id || "--";
      item.querySelector("span").textContent = device.label || "--";
      deviceList.appendChild(item);
    });
  }

  function renderPayload(payload) {
    const samples = Array.isArray(payload.samples) ? payload.samples : [];
    const hours = Math.max(1, Number(rangeSelect && rangeSelect.value) || 24);

    lastPayload = payload;
    rangeTitle.textContent = formatRange(hours);
    renderLatest(payload);
    drawChart(samples);
    renderEvents(samples);
    renderDevices(payload.latest);

    if (footnote) {
      footnote.textContent =
        "Samples: " +
        samples.length +
        " / interval: " +
        payload.sample_interval_seconds +
        "s / retention: " +
        payload.retention_days +
        "d";
    }
  }

  async function loadDebugData() {
    const hours = Math.max(1, Number(rangeSelect && rangeSelect.value) || 24);

    refreshButton.disabled = true;

    try {
      const response = await fetch(endpoint + "?hours=" + encodeURIComponent(String(hours)), {
        headers: { accept: "application/json" },
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Unable to load debug data.");
      }

      renderPayload(payload);
    } catch (error) {
      setField("power", "Load Failed", error.message, "bad");
      setField("usb", "Load Failed", config.usbRadioId || "--", "bad");
    } finally {
      refreshButton.disabled = false;
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
    }

    refreshTimer = window.setInterval(loadDebugData, pollMs);
  }

  if (rangeSelect) {
    rangeSelect.addEventListener("change", loadDebugData);
  }

  if (refreshButton) {
    refreshButton.addEventListener("click", loadDebugData);
  }

  window.addEventListener("resize", function onResize() {
    if (lastPayload) {
      drawChart(Array.isArray(lastPayload.samples) ? lastPayload.samples : []);
    }
  });

  loadDebugData();
  scheduleRefresh();
})();
