// RescueEye — Command Center Application
// Professional aviation/emergency-response UI

// ── Types ──────────────────────────────────────────────────────────────

interface AppTelemetry {
  droneId: string;
  latitude: number;
  longitude: number;
  altitude: number;
  relativeAltitude: number;
  heading: number;
  groundSpeed: number;
  verticalSpeed: number;
  batteryPercentage: number;
  voltage: number;
  gpsFix: boolean;
  satelliteCount: number;
  flightMode: string;
  connectionState: string;
  flightDurationSeconds: number;
  distanceFromHomeMeters: number;
  timestamp: number;
}

interface AppDetection {
  id: string;
  class: string;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
  timestamp: number;
  frameId: string;
  sourceDroneId: string;
  latitude?: number;
  longitude?: number;
}

interface AppMission {
  id: string;
  name: string;
  description: string;
  status: string;
  droneId: string;
  searchArea?: any;
  waypoints: any[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  detections: string[];
  warnings: string[];
  estimatedDistanceMeters: number;
  estimatedDurationSeconds: number;
  coveragePercent: number;
  batteryEstimatePercent: number;
}

interface AppAlert {
  id: string;
  droneId: string;
  type: string;
  severity: string;
  message: string;
  timestamp: number;
  acknowledged: boolean;
}

interface AppEvent {
  id: string;
  missionId: string;
  droneId: string;
  type: string;
  severity: string;
  message: string;
  timestamp: number;
}

// ── Application ─────────────────────────────────────────────────────────

export class RescueEyeApp {
  private ws: WebSocket | null = null;
  private telemetry: AppTelemetry | null = null;
  private detections: AppDetection[] = [];
  private missions: AppMission[] = [];
  private alerts: AppAlert[] = [];
  private events: AppEvent[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelayMs = 2000;
  private container!: HTMLElement;

  mount(container: HTMLElement): void {
    this.container = container;
    this.container.innerHTML = this._render();
    this._connectWebSocket();
    this._startClock();
    this._bindEvents();
  }

  // ── WebSocket ─────────────────────────────────────────────────────

  private _connectWebSocket(): void {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      // Fallback: try localhost for dev
      this.ws = new WebSocket("ws://localhost:8080/ws");
    }

    this.ws.onopen = () => {
      console.log("WebSocket connected");
      this.reconnectAttempts = 0;
      this._updateConnectionState("CONNECTED");
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleMessage(msg);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this._updateConnectionState("DISCONNECTED");
      this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      this._updateConnectionState("DISCONNECTED");
    };
  }

  private _scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    setTimeout(() => {
      this._connectWebSocket();
    }, this.reconnectDelayMs * this.reconnectAttempts);
  }

  private _handleMessage(msg: any): void {
    switch (msg.type) {
      case "TELEMETRY":
        this.telemetry = msg.payload;
        this._updateTelemetryPanel();
        this._updateMapMarkers();
        break;
      case "DETECTION":
        this.detections.push(msg.payload);
        if (this.detections.length > 200) this.detections = this.detections.slice(-200);
        this._updateDetectionPanel();
        this._updateMapMarkers();
        break;
      case "ALERT":
        this.alerts.unshift(msg.payload);
        if (this.alerts.length > 50) this.alerts = this.alerts.slice(0, 50);
        this._updateAlertPanel();
        break;
      case "MISSION_STATE":
        this._updateMission(msg.payload);
        this._updateMissionPanel();
        break;
      case "CONNECTION_STATE":
        this._updateConnectionState(msg.payload.state);
        break;
      case "MISSIONS_LIST":
        this.missions = msg.payload;
        this._updateMissionPanel();
        break;
      case "ALERTS_LIST":
        this.alerts = msg.payload;
        this._updateAlertPanel();
        break;
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────

  private _render(): string {
    return `
      <div id="rescueeye-app" class="re-app">
        <!-- TOP BAR -->
        <header class="re-topbar">
          <div class="re-topbar-left">
            <h1 class="re-logo">🛸 RescueEye</h1>
            <span class="re-badge" id="re-conn-badge">DISCONNECTED</span>
          </div>
          <div class="re-topbar-center">
            <span class="re-mission-status" id="re-mission-status">NO ACTIVE MISSION</span>
          </div>
          <div class="re-topbar-right">
            <span class="re-clock" id="re-clock">--:--:--</span>
            <span class="re-system-health" id="re-health">●</span>
          </div>
        </header>

        <!-- MAIN LAYOUT -->
        <div class="re-main">
          <!-- LEFT PANEL -->
          <aside class="re-left-panel">
            <div class="re-panel">
              <h3>Missions</h3>
              <div class="re-mission-list" id="re-mission-list">
                <p class="re-empty">No missions</p>
              </div>
            </div>
            <div class="re-panel">
              <h3>Connected UAVs</h3>
              <div class="re-drone-list" id="re-drone-list">
                <p class="re-empty">No drones connected</p>
              </div>
            </div>
            <div class="re-panel">
              <h3>Search Operations</h3>
              <div class="re-search-list" id="re-search-list">
                <p class="re-empty">No active search areas</p>
              </div>
            </div>
          </aside>

          <!-- CENTER -->
          <main class="re-center">
            <div class="re-view-tabs">
              <button class="re-tab active" data-view="map">Map</button>
              <button class="re-tab" data-view="camera">Camera</button>
              <button class="re-tab" data-view="split">Split</button>
            </div>
            <div class="re-canvas-container" id="re-map-container">
              <canvas id="re-map-canvas"></canvas>
            </div>
            <div class="re-canvas-container re-hidden" id="re-camera-container">
              <video id="re-camera-video" autoplay muted></video>
              <div class="re-camera-overlay">
                <span class="re-camera-stats" id="re-camera-stats">No camera source</span>
              </div>
            </div>
          </main>

          <!-- RIGHT PANEL -->
          <aside class="re-right-panel">
            <div class="re-panel re-telemetry-panel">
              <h3>Telemetry</h3>
              <div class="re-telemetry-grid" id="re-telemetry">
                ${this._renderTelemetryPlaceholder()}
              </div>
            </div>
            <div class="re-panel">
              <h3>Detections</h3>
              <div class="re-detection-list" id="re-detection-list">
                <p class="re-empty">No detections</p>
              </div>
            </div>
            <div class="re-panel">
              <h3>Drone Health</h3>
              <div id="re-drone-health">
                ${this._renderDroneHealthPlaceholder()}
              </div>
            </div>
          </aside>
        </div>

        <!-- BOTTOM BAR -->
        <footer class="re-bottombar">
          <div class="re-controls">
            <button class="re-btn re-btn-primary" id="re-btn-start">▶ Start</button>
            <button class="re-btn re-btn-warning" id="re-btn-pause">⏸ Pause</button>
            <button class="re-btn re-btn-danger" id="re-btn-abort">⏹ Abort</button>
            <button class="re-btn" id="re-btn-rth">🏠 RTH</button>
            <button class="re-btn" id="re-btn-land">✈ Land</button>
          </div>
          <div class="re-warnings" id="re-warnings">
            <span class="re-warning-item">All systems nominal</span>
          </div>
          <div class="re-timeline" id="re-timeline">
            <div class="re-timeline-header">Event Timeline</div>
            <div class="re-timeline-body" id="re-timeline-body"></div>
          </div>
        </footer>
      </div>
    `;
  }

  private _renderTelemetryPlaceholder(): string {
    const rows = [
      "ALT", "SPD", "V/S", "HDG", "BAT", "GPS", "SAT", "LINK", "MODE", "DIST HOME", "FLIGHT TIME"
    ];
    return rows.map((r) => `
      <div class="re-telemetry-row">
        <span class="re-telemetry-label">${r}</span>
        <span class="re-telemetry-value" id="re-tel-${r.toLowerCase().replace(/\s/g, '-')}">--</span>
      </div>
    `).join("");
  }

  private _renderDroneHealthPlaceholder(): string {
    return `
      <div class="re-health-item"><span>CPU</span><span>--</span></div>
      <div class="re-health-item"><span>Memory</span><span>--</span></div>
      <div class="re-health-item"><span>Vision Latency</span><span>--</span></div>
      <div class="re-health-item"><span>Video FPS</span><span>--</span></div>
      <div class="re-health-item"><span>Telemetry Latency</span><span>--</span></div>
    `;
  }

  // ── Updates ────────────────────────────────────────────────────────

  private _updateTelemetryPanel(): void {
    if (!this.telemetry) return;
    const t = this.telemetry;

    const set = (id: string, val: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    set("re-tel-alt", `${t.altitude.toFixed(1)} m`);
    set("re-tel-spd", `${t.groundSpeed.toFixed(1)} m/s`);
    set("re-tel-v-s", `${t.verticalSpeed.toFixed(1)} m/s`);
    set("re-tel-hdg", `${t.heading.toFixed(0)}°`);
    set("re-tel-bat", `${t.batteryPercentage.toFixed(1)}%`);
    set("re-tel-gps", t.gpsFix ? "OK" : "NO FIX");
    set("re-tel-sat", `${t.satelliteCount}`);
    set("re-tel-link", t.connectionState);
    set("re-tel-mode", t.flightMode);
    set("re-tel-dist-home", `${t.distanceFromHomeMeters.toFixed(0)} m`);
    set("re-tel-flight-time", this._formatDuration(t.flightDurationSeconds));

    // Color-code battery
    const batEl = document.getElementById("re-tel-bat");
    if (batEl) {
      batEl.className = "re-telemetry-value " + this._batteryClass(t.batteryPercentage);
    }

    // Color-code connection
    const linkEl = document.getElementById("re-tel-link");
    if (linkEl) {
      linkEl.className = "re-telemetry-value " + this._connectionClass(t.connectionState);
    }

    // Update drone health
    this._updateDroneHealth();
  }

  private _updateMapMarkers(): void {
    const canvas = document.getElementById("re-map-canvas") as HTMLCanvasElement;
    if (!canvas || !this.telemetry) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Draw grid
    ctx.strokeStyle = "rgba(0,150,255,0.1)";
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 50) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 50) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // Draw UAV position (center)
    const cx = w / 2;
    const cy = h / 2;
    const t = this.telemetry;

    // Home marker
    ctx.fillStyle = "#00ff88";
    ctx.beginPath();
    ctx.arc(cx - 60, cy - 40, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#88ffbb";
    ctx.font = "10px monospace";
    ctx.fillText("HOME", cx - 60, cy - 50);

    // UAV marker
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((-t.heading * Math.PI) / 180);

    // Drone triangle
    ctx.fillStyle = "#ff4444";
    ctx.beginPath();
    ctx.moveTo(0, -15);
    ctx.lineTo(-10, 10);
    ctx.lineTo(10, 10);
    ctx.closePath();
    ctx.fill();

    // Heading line
    ctx.strokeStyle = "#ffaa00";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -25);
    ctx.stroke();

    ctx.restore();

    // Label
    ctx.fillStyle = "#ffffff";
    ctx.font = "11px monospace";
    ctx.fillText(`ALT ${t.altitude.toFixed(0)}m | SPD ${t.groundSpeed.toFixed(1)}m/s | HDG ${t.heading.toFixed(0)}°`, cx - 80, cy + 30);

    // Draw detections as markers
    this.detections.forEach((det, i) => {
      const dx = cx + (Math.random() - 0.5) * 200;
      const dy = cy + (Math.random() - 0.5) * 200;
      ctx.fillStyle = det.class === "person" ? "#ff00ff" : "#ffff00";
      ctx.beginPath();
      ctx.arc(dx, dy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "9px monospace";
      ctx.fillText(`${det.class} ${(det.confidence * 100).toFixed(0)}%`, dx + 6, dy + 3);
    });
  }

  private _updateDetectionPanel(): void {
    const el = document.getElementById("re-detection-list");
    if (!el) return;
    if (this.detections.length === 0) {
      el.innerHTML = '<p class="re-empty">No detections</p>';
      return;
    }
    el.innerHTML = this.detections.slice(-20).reverse().map((d) => `
      <div class="re-detection-item">
        <span class="re-det-class">${d.class}</span>
        <span class="re-det-conf">${(d.confidence * 100).toFixed(1)}%</span>
        <span class="re-det-time">${new Date(d.timestamp).toLocaleTimeString()}</span>
      </div>
    `).join("");
  }

  private _updateAlertPanel(): void {
    const el = document.getElementById("re-warnings");
    if (!el) return;
    if (this.alerts.length === 0) {
      el.innerHTML = '<span class="re-warning-item">All systems nominal</span>';
      return;
    }
    el.innerHTML = this.alerts.slice(0, 5).map((a) => {
      const cls = a.severity === "CRITICAL" ? "re-warning-critical" :
                  a.severity === "WARNING" ? "re-warning-warning" : "re-warning-info";
      return `<span class="re-warning-item ${cls}">${a.message}</span>`;
    }).join("");
  }

  private _updateMissionPanel(): void {
    const el = document.getElementById("re-mission-list");
    if (!el) return;
    if (this.missions.length === 0) {
      el.innerHTML = '<p class="re-empty">No missions</p>';
      return;
    }
    el.innerHTML = this.missions.map((m) => `
      <div class="re-mission-item re-status-${m.status.toLowerCase()}">
        <span class="re-mission-name">${m.name}</span>
        <span class="re-mission-status">${m.status}</span>
      </div>
    `).join("");
  }

  private _updateMission(mission: AppMission): void {
    const idx = this.missions.findIndex((m) => m.id === mission.id);
    if (idx >= 0) {
      this.missions[idx] = mission;
    } else {
      this.missions.push(mission);
    }
    this._updateMissionPanel();

    const statusEl = document.getElementById("re-mission-status");
    if (statusEl) {
      statusEl.textContent = `Mission: ${mission.name} (${mission.status})`;
    }
  }

  private _updateConnectionState(state: string): void {
    const badge = document.getElementById("re-conn-badge");
    if (badge) {
      badge.textContent = state;
      badge.className = "re-badge re-badge-" + state.toLowerCase();
    }
  }

  private _updateDroneHealth(): void {
    // Update with simulated health data
    const items = document.querySelectorAll("#re-drone-health .re-health-item");
    if (items.length >= 5) {
      items[0].querySelector("span:last-child")!.textContent = Math.floor(10 + Math.random() * 30) + "%";
      items[1].querySelector("span:last-child")!.textContent = Math.floor(100 + Math.random() * 200) + " MB";
      items[2].querySelector("span:last-child")!.textContent = (5 + Math.random() * 20).toFixed(1) + " ms";
      items[3].querySelector("span:last-child")!.textContent = "25 FPS";
      items[4].querySelector("span:last-child")!.textContent = (10 + Math.random() * 50).toFixed(0) + " ms";
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private _startClock(): void {
    const update = () => {
      const el = document.getElementById("re-clock");
      if (el) el.textContent = new Date().toLocaleTimeString();
    };
    update();
    setInterval(update, 1000);
  }

  private _bindEvents(): void {
    // Tab switching
    document.querySelectorAll(".re-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".re-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const view = tab.getAttribute("data-view");
        const mapEl = document.getElementById("re-map-container");
        const camEl = document.getElementById("re-camera-container");
        if (mapEl) mapEl.classList.toggle("re-hidden", view !== "map" && view !== "split");
        if (camEl) camEl.classList.toggle("re-hidden", view !== "camera" && view !== "split");
      });
    });

    // Mission controls
    const startBtn = document.getElementById("re-btn-start");
    const pauseBtn = document.getElementById("re-btn-pause");
    const abortBtn = document.getElementById("re-btn-abort");
    const rthBtn = document.getElementById("re-btn-rth");
    const landBtn = document.getElementById("re-btn-land");

    startBtn?.addEventListener("click", () => this._sendWsCommand("START_MISSION"));
    pauseBtn?.addEventListener("click", () => this._sendWsCommand("PAUSE_MISSION"));
    abortBtn?.addEventListener("click", () => this._sendWsCommand("ABORT_MISSION"));
    rthBtn?.addEventListener("click", () => this._sendWsCommand("RTH"));
    landBtn?.addEventListener("click", () => this._sendWsCommand("LAND"));
  }

  private _sendWsCommand(action: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "MISSION_CONTROL", payload: { action } }));
    }
  }

  private _formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  private _batteryClass(pct: number): string {
    if (pct < 10) return "re-critical";
    if (pct < 20) return "re-warning";
    return "re-normal";
  }

  private _connectionClass(state: string): string {
    if (state === "CONNECTED") return "re-normal";
    if (state === "LOST" || state === "DISCONNECTED") return "re-critical";
    return "re-warning";
  }
}
