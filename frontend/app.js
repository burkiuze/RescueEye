// RescueEye command centre console.
//
// Plain browser JS on purpose: the console has to load from a field laptop
// over a flaky link, and every dependency is a thing that can fail to load
// when an operator needs the map.
//
// Two behaviours worth calling out:
//  * The token lives in sessionStorage, not localStorage, so closing the tab
//    ends the session rather than leaving a credential on a shared machine.
//  * Synthetic detections are rendered with a visible SIMULATED tag. A rescuer
//    must never be able to mistake demo output for a person.

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const KEY = "rescueeye.token";

  const state = {
    token: null,
    role: null,
    ws: null,
    missions: [],
    detections: [],
    activeMissionId: null,
    track: [],
    reconnectDelay: 1000,
    toastTimer: null,
  };

  // ── HTTP ──────────────────────────────────────────────────────

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${state.token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error((body && body.message) || (body && body.error) || res.statusText);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // ── Feedback ──────────────────────────────────────────────────

  function toast(message, kind = "") {
    const el = $("toast");
    el.textContent = message;
    el.className = `toast ${kind}`;
    el.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  function fail(err) {
    if (err.status === 401) return signOut("Session expired — sign in again");
    toast(err.message || String(err), "err");
  }

  // ── Session ───────────────────────────────────────────────────

  function signIn(token) {
    state.token = token;
    sessionStorage.setItem(KEY, token);

    // Probe identity before revealing the console.
    return api("/api/operators").then(() => {
      // Operators endpoint is admin-only; fall back to a capability probe.
      return probeRole();
    }).catch((err) => {
      if (err.status === 401) {
        sessionStorage.removeItem(KEY);
        state.token = null;
        throw new Error("Token rejected");
      }
      // Non-401 means the token worked (403 = authenticated, wrong role).
      return probeRole();
    });
  }

  // Determine role via read-only endpoints.
  //
  // Deliberately uses GET-only probes. An earlier version identified the
  // safety officer by firing a real RTH command at login time, which meant the
  // act of signing in could order a flying aircraft home. Role discovery must
  // never move the aircraft.
  async function probeRole() {
    // /api/operators is admin-only; /api/audit is config:write-only. Neither is
    // useful here, so infer from the identity endpoint added for this purpose.
    const me = await api("/api/me");
    state.role = me.role;
    state.username = me.username;
    return me.role;
  }

  function signOut(message) {
    if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
    state.token = null;
    state.role = null;
    sessionStorage.removeItem(KEY);
    $("app").hidden = true;
    $("gate").hidden = false;
    if (message) $("gate-error").textContent = message;
    $("gate-error").hidden = !message;
  }

  // ── WebSocket ─────────────────────────────────────────────────

  function connectWs() {
    if (!state.token) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws?token=${encodeURIComponent(state.token)}`;

    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      state.reconnectDelay = 1000;
      setLink("LIVE", "pill-ok");
      refreshAll();
    };

    ws.onclose = () => {
      setLink("OFFLINE", "pill-off");
      scheduleReconnect();
    };

    ws.onerror = () => { /* close handler drives retry */ };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handle(msg);
    };
  }

  function scheduleReconnect() {
    if (!state.token) return;
    // Back off, but stay responsive: an operator reconnects quickly by hand if
    // we back off too far.
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.7, 10000);
    setTimeout(connectWs, state.reconnectDelay);
  }

  function handle(msg) {
    switch (msg.type) {
      case "TELEMETRY": renderTelemetry(msg.payload); break;
      case "MISSION_STATE": upsertMission(msg.payload); renderMissions(); break;
      case "DETECTION": addDetection(msg.payload); break;
      case "EVENT": addEvent(msg.payload); break;
      case "SAFETY_STATE":
        renderSafety(msg.payload.state);
        break;
      case "ALERT":
        addEvent({
          id: msg.payload.id,
          type: msg.payload.type,
          severity: msg.payload.severity,
          message: msg.payload.message,
          timestamp: msg.payload.timestamp,
        });
        break;
      case "MISSIONS_LIST": state.missions = msg.payload; renderMissions(); break;
      case "DETECTIONS_LIST": state.detections = msg.payload; renderDetections(); break;
    }
  }

  // ── Rendering: telemetry ──────────────────────────────────────

  function set(id, text, cls) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = `v ${cls || ""}`;
  }

  function batteryClass(pct) {
    return pct < 10 ? "v-bad" : pct < 25 ? "v-warn" : "v-ok";
  }

  function renderTelemetry(t) {
    if (!t) return;
    set("t-alt", `${t.altitude.toFixed(0)} m`);
    set("t-spd", `${t.groundSpeed.toFixed(1)} m/s`);
    set("t-vs", `${t.verticalSpeed >= 0 ? "+" : ""}${t.verticalSpeed.toFixed(1)} m/s`);
    set("t-hdg", `${t.heading.toFixed(0)}\u00b0`);
    set("t-bat", `${t.batteryPercentage.toFixed(0)}%`, batteryClass(t.batteryPercentage));
    set("t-volt", `${t.voltage.toFixed(1)} V`);
    set("t-gps", t.gpsFix ? "FIX" : "NO FIX", t.gpsFix ? "v-ok" : "v-bad");
    set("t-sat", String(t.satelliteCount), t.satelliteCount >= 6 ? "v-ok" : "v-warn");
    set("t-mode", t.flightMode);
    set("t-link", t.connectionState, t.connectionState === "CONNECTED" ? "v-ok" : "v-bad");
    set("t-home", `${t.distanceFromHomeMeters.toFixed(0)} m`);
    set("t-time", formatDuration(t.flightDurationSeconds));

    // Keep a bounded track for the map.
    state.track.push({ lat: t.latitude, lon: t.longitude, hdg: t.heading });
    if (state.track.length > 400) state.track.shift();

    drawMap(t);
  }

  function formatDuration(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  // Schematic plan view. Not a survey chart — it exists to show relative
  // position, heading and the flown track at a glance.
  function drawMap(t) {
    const cv = $("map");
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const w = cv.width;
    const h = cv.height;

    ctx.fillStyle = "#060a10";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(58,167,255,0.09)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

    if (state.track.length < 2) return;

    // Scale so the track plus home always fit.
    const lats = state.track.map((p) => p.lat).concat(t.homeLatitude);
    const lons = state.track.map((p) => p.lon).concat(t.homeLongitude);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const padLat = Math.max((maxLat - minLat) * 0.2, 1e-4);
    const padLon = Math.max((maxLon - minLon) * 0.2, 1e-4);
    const lo0 = minLon - padLon, la0 = maxLat + padLat;
    const spanLon = (maxLon + padLon) - lo0;
    const spanLat = la0 - (minLat - padLat);

    const px = (lon) => ((lon - lo0) / spanLon) * w;
    const py = (lat) => ((la0 - lat) / spanLat) * h;

    // Flown track.
    ctx.strokeStyle = "rgba(58,167,255,0.65)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    state.track.forEach((p, i) => (i ? ctx.lineTo(px(p.lon), py(p.lat)) : ctx.moveTo(px(p.lon), py(p.lat))));
    ctx.stroke();

    // Home.
    const hx = px(t.homeLongitude), hy = py(t.homeLatitude);
    ctx.strokeStyle = "#22d37a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hx - 7, hy); ctx.lineTo(hx + 7, hy);
    ctx.moveTo(hx, hy - 7); ctx.lineTo(hx, hy + 7);
    ctx.stroke();
    ctx.fillStyle = "#22d37a";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("HOME", hx + 10, hy + 3);

    // Aircraft.
    const ax = px(t.longitude), ay = py(t.latitude);
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate((t.heading * Math.PI) / 180);
    ctx.fillStyle = "#ff4d4d";
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(-7, -7);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-7, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Detections near the track.
    for (const d of state.detections) {
      if (d.latitude == null || d.longitude == null) continue;
      const dx = px(d.longitude), dy = py(d.latitude);
      if (dx < 0 || dx > w || dy < 0 || dy > h) continue;
      ctx.fillStyle = d.provenance === "SYNTHETIC" ? "#b57bff" : "#f0a417";
      ctx.beginPath();
      ctx.arc(dx, dy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Rendering: missions ───────────────────────────────────────

  function upsertMission(m) {
    if (!m) return;
    const i = state.missions.findIndex((x) => x.id === m.id);
    if (i >= 0) state.missions[i] = m;
    else state.missions.unshift(m);
  }

  function renderMissions() {
    const el = $("missions");
    if (!state.missions.length) {
      el.innerHTML = '<p class="empty">none</p>';
      $("mission").textContent = "NO ACTIVE MISSION";
      return;
    }
    el.innerHTML = state.missions.slice(0, 20).map((m) => `
      <div class="item" data-id="${m.id}" style="cursor:pointer">
        <div class="item-head">
          <span class="item-title">${escapeHtml(m.name)}</span>
          <span class="tag t-${m.status.toLowerCase()}">${m.status}</span>
        </div>
        <div class="item-sub">${new Date(m.createdAt).toLocaleString()}</div>
      </div>`).join("");

    el.querySelectorAll(".item").forEach((node) => {
      node.onclick = () => { state.activeMissionId = node.dataset.id; renderMissions(); };
    });

    const active = state.missions.find((m) => m.id === state.activeMissionId)
      || state.missions.find((m) => m.status === "ACTIVE")
      || state.missions[0];
    state.activeMissionId = active.id;
    $("mission").textContent = `${active.name} — ${active.status}`;

    // Only enable transitions the current state allows.
    const canControl = state.role === "operator" || state.role === "safetyOfficer";
    $("act-start").disabled = !canControl || !["PLANNED", "READY", "PAUSED"].includes(active.status);
    $("act-pause").disabled = !canControl || active.status !== "ACTIVE";
    $("act-abort").disabled = !canControl || !["PLANNED", "READY", "ACTIVE", "PAUSED"].includes(active.status);
  }

  // ── Rendering: detections + events ────────────────────────────

  function addDetection(d) {
    if (!d) return;
    state.detections.push(d);
    if (state.detections.length > 300) state.detections.shift();
    renderDetections();
  }

  function renderDetections() {
    const el = $("detections");
    if (!state.detections.length) {
      el.innerHTML = '<p class="empty">none</p>';
      return;
    }
    el.innerHTML = state.detections.slice(-40).reverse().map((d) => {
      const sim = d.provenance === "SYNTHETIC";
      return `
        <div class="item">
          <div class="item-head">
            <span class="det-class">${escapeHtml(d.class)}</span>
            <span class="tag ${sim ? "det-sim" : "det-real"}">${sim ? "SIMULATED" : "MODEL"}</span>
          </div>
          <div class="item-sub">${(d.confidence * 100).toFixed(0)}% · ${new Date(d.timestamp).toLocaleTimeString()}</div>
        </div>`;
    }).join("");
  }

  const EVENTS_MAX = 300;

  function addEvent(e) {
    if (!e) return;
    const el = $("events");
    const node = document.createElement("div");
    node.className = `ev ev-${e.severity}`;
    node.innerHTML = `<span class="ev-time">${new Date(e.timestamp).toLocaleTimeString()}</span> ${escapeHtml(e.message)}`;
    el.prepend(node);
    while (el.children.length > EVENTS_MAX) el.removeChild(el.lastChild);
    if (el.querySelector(".empty")) el.innerHTML = "";
  }

  // ── Safety + health ───────────────────────────────────────────

  function renderSafety(s) {
    const el = $("safety");
    const map = {
      NORMAL: ["SAFETY NORMAL", "pill-ok"],
      LOW_BATTERY_WARNING: ["LOW BATTERY", "pill-warn"],
      CRITICAL_BATTERY: ["CRITICAL BATTERY", "pill-bad"],
      GPS_DEGRADED: ["GPS DEGRADED", "pill-warn"],
      CONNECTION_LOST: ["LINK LOST", "pill-bad"],
      GEOFENCE_WARNING: ["GEOFENCE", "pill-warn"],
      HIGH_WIND_WARNING: ["HIGH WIND", "pill-warn"],
      TELEMETRY_TIMEOUT: ["TELEMETRY TIMEOUT", "pill-bad"],
    };
    const [text, cls] = map[s] || [s || "SAFETY NORMAL", "pill-ok"];
    el.textContent = text;
    el.className = `pill ${cls}`;
  }

  function setLink(text, cls) {
    const el = $("link");
    el.textContent = text;
    el.className = `pill ${cls}`;
  }

  async function pollHealth() {
    try {
      const res = await fetch("/healthz");
      const h = await res.json();
      $("health").textContent =
        `health ${h.status} · mem ${h.memoryMB}MB · lag ${h.telemetryLatencyMs}ms · ` +
        `missions ${h.missions} · events ${h.events} · overrides ${h.activeOverrides}` +
        (h.corruptLines ? ` · CORRUPT ${h.corruptLines}` : "");
    } catch {
      $("health").textContent = "health unreachable";
    }
  }

  // ── Actions ───────────────────────────────────────────────────

  async function missionAction(action) {
    if (!state.activeMissionId) return toast("No mission selected", "err");
    try {
      const m = await api(`/api/missions/${state.activeMissionId}/${action}`, { method: "POST" });
      upsertMission(m);
      renderMissions();
      toast(`${action}: ${m.status}`, "ok");
    } catch (err) { fail(err); }
  }

  async function refreshAll() {
    try {
      state.missions = await api("/api/missions");
      renderMissions();
      state.detections = await api("/api/detections");
      renderDetections();
      const t = await api("/api/telemetry");
      renderTelemetry(t);
      const ov = await api("/api/failsafe/overrides");
      renderOverrides(ov);
    } catch (err) { fail(err); }
  }

  function renderOverrides(list) {
    const el = $("overrides");
    if (!list.length) { el.innerHTML = '<p class="empty">none</p>'; return; }
    el.innerHTML = list.map((o) => `
      <div class="item">
        <div class="item-head">
          <span class="item-title">${escapeHtml(o.safetyState)}</span>
          <span class="tag pill-warn">OVERRIDE</span>
        </div>
        <div class="item-sub">${escapeHtml(o.operatorUsername)} · expires ${new Date(o.expiresAt).toLocaleTimeString()}</div>
        <div class="item-sub">${escapeHtml(o.reason)}</div>
      </div>`).join("");
  }

  // ── Wiring ────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function boot() {
    $("gate-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      $("gate-error").hidden = true;
      const token = $("token").value.trim();
      if (!token) return;
      try {
        const role = await signIn(token);
        $("gate").hidden = true;
        $("app").hidden = false;
        $("token").value = "";
        $("who").textContent = `${state.role} · ${role}`;
        applyRolePermissions();
        connectWs();
        pollHealth();
      } catch (err) {
        $("gate-error").textContent = "Token rejected";
        $("gate-error").hidden = false;
      }
    });

    $("mission-new").onclick = async () => {
      const name = $("mission-name").value.trim();
      if (!name) return toast("Enter a mission name", "err");
      try {
        const m = await api("/api/missions", { method: "POST", body: JSON.stringify({ name }) });
        $("mission-name").value = "";
        state.activeMissionId = m.id;
        upsertMission(m);
        renderMissions();
        toast(`Created "${m.name}"`, "ok");
      } catch (err) { fail(err); }
    };

    $("act-start").onclick = () => missionAction("start");
    $("act-pause").onclick = () => missionAction("pause");
    $("act-abort").onclick = () => missionAction("abort");

    $("act-rth").onclick = async () => {
      try {
        await api("/api/drone/rth", { method: "POST" });
        toast("Return to home commanded", "ok");
      } catch (err) { fail(err); }
    };

    $("act-land").onclick = async () => {
      try {
        await api("/api/drone/land", { method: "POST" });
        toast("Landing commanded", "ok");
      } catch (err) { fail(err); }
    };

    $("act-logout").onclick = () => signOut();

    $("ovr-add").onclick = async () => {
      const stateName = $("ovr-state").value.trim();
      const reason = $("ovr-reason").value.trim();
      if (!stateName || reason.length < 10) {
        return toast("State plus a 10+ character reason are required", "err");
      }
      try {
        await api("/api/failsafe/override", {
          method: "POST",
          body: JSON.stringify({ state: stateName, reason, durationMs: 120000 }),
        });
        $("ovr-reason").value = "";
        renderOverrides(await api("/api/failsafe/overrides"));
        toast("Override active for 2 minutes", "ok");
      } catch (err) { fail(err); }
    };

    // Resume an existing session if one is present.
    const saved = sessionStorage.getItem(KEY);
    if (saved) {
      state.token = saved;
      probeRole()
        .then(() => {
          $("gate").hidden = true;
          $("app").hidden = false;
          $("who").textContent = state.role;
          applyRolePermissions();
          connectWs();
          pollHealth();
        })
        .catch(() => signOut());
    }

    setInterval(() => {
      const el = $("clock");
      if (el) el.textContent = new Date().toLocaleTimeString();
    }, 1000);
    setInterval(pollHealth, 5000);
  }

  // Hide controls the signed-in role cannot use, rather than letting them
  // click and receive a 403.
  function applyRolePermissions() {
    const canControl = state.role === "operator" || state.role === "safetyOfficer";
    const canCommand = state.role === "safetyOfficer";
    const canOverride = state.role === "safetyOfficer";

    $("mission-new").disabled = !canControl;
    $("mission-name").disabled = !canControl;
    $("act-rth").disabled = !canCommand;
    $("act-land").disabled = !canCommand;
    $("ovr-add").disabled = !canOverride;
    $("ovr-state").disabled = !canOverride;
    $("ovr-reason").disabled = !canOverride;
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
