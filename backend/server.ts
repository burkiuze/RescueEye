// RescueEye — Backend Server
// WebSocket + REST API for telemetry, missions, detections, and events.

import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import type {
  Telemetry,
  Detection,
  Mission,
  MissionEvent,
  Alert,
  WSMessage,
  ConnectionState,
  MissionStatus,
  Severity,
  EventType,
  SimulatorConfig,
  SystemHealth,
  BoundingBox,
} from "../shared/models";
import { TelemetryService } from "./telemetry_service";
import { SimulatorDroneAdapter } from "../simulator/simulator_adapter";
import { DroneAdapterFactoryImpl } from "../drone/connection_manager";
import type { DroneAdapter } from "../drone/adapter";

// ── Simple UUID generator ──────────────────────────────────────────────

function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── REST Router ────────────────────────────────────────────────────────

interface Route {
  method: string;
  path: string;
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => Promise<void> | void;
}

class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Route["handler"]): void {
    this.routes.push({ method, path, handler });
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const body = await this._readBody(req);

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      if (route.path !== url.pathname) continue;
      await route.handler(req, res, body);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private async _readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
  }
}

// ── RescueEye Server ───────────────────────────────────────────────────

export interface ServerConfig {
  port: number;
  wsPath: string;
  droneAdapter: DroneAdapter;
  simulatorConfig?: Partial<SimulatorConfig>;
}

export class RescueEyeServer {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private router: Router;
  private telemetryService: TelemetryService;
  private droneAdapter: DroneAdapter;
  private clients: Set<WebSocket> = new Set();
  private missions: Map<string, Mission> = new Map();
  private events: MissionEvent[] = [];
  private detections: Detection[] = [];
  private _tickInterval: number | NodeJS.Timeout | null = null;
  private _simAdapter: SimulatorDroneAdapter | null = null;

  constructor(config: ServerConfig) {
    this.droneAdapter = config.droneAdapter;
    this.telemetryService = new TelemetryService(3000);
    this.router = new Router();
    this._setupRoutes();
    this._setupWebSocket();
    this.httpServer = http.createServer((req, res) => this._handleHttpRequest(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer, path: config.wsPath });
    this._simAdapter = config.droneAdapter instanceof SimulatorDroneAdapter ? config.droneAdapter : null;
  }

  async start(): Promise<void> {
    // Connect drone
    await this.droneAdapter.connect();

    // Wire telemetry
    this.droneAdapter.onTelemetry((t) => {
      this.telemetryService.update(t);
      this._broadcast({ type: "TELEMETRY", payload: t, timestamp: Date.now(), source: "server" });
    });

    this.droneAdapter.onConnectionChange((state) => {
      this._broadcast({ type: "CONNECTION_STATE", payload: { droneId: this.droneAdapter.droneId, state }, timestamp: Date.now(), source: "server" });
    });

    // Start telemetry health monitoring
    this.telemetryService.startHealthMonitoring(1000);

    // Wire alerts
    this.telemetryService.onAlert((alert) => {
      this._broadcast({ type: "ALERT", payload: alert, timestamp: Date.now(), source: "server" });
      this._addEvent("ALERT", "WARNING", alert.message, { alertId: alert.id, droneId: alert.droneId });
    });

    // Start simulation tick if simulator
    if (this._simAdapter) {
      this._startSimulationTick();
    }

    const port = (this.httpServer.address() as any)?.port ?? 8080;
    console.log(`RescueEye server started on port ${port}`);
  }

  stop(): void {
    this._stopSimulationTick();
    this.telemetryService.stopHealthMonitoring();
    this.droneAdapter.disconnect();
    this.wss.close();
    this.httpServer.close();
  }

  getHttpServer(): http.Server {
    return this.httpServer;
  }

  // ── HTTP Routes ────────────────────────────────────────────────────

  private _setupRoutes(): void {
    // GET /api/health
    this.router.add("GET", "/api/health", (_req, res) => {
      this._json(res, 200, { status: "ok", uptime: process.uptime() });
    });

    // GET /api/telemetry
    this.router.add("GET", "/api/telemetry", (_req, res) => {
      const t = this.telemetryService.getTelemetry();
      this._json(res, 200, t ?? { error: "No telemetry" });
    });

    // GET /api/telemetry/latest
    this.router.add("GET", "/api/telemetry/latest", (_req, res) => {
      try {
        const t = this.telemetryService.getLatest();
        this._json(res, 200, t);
      } catch (e) {
        this._json(res, 404, { error: "No telemetry available" });
      }
    });

    // GET /api/alerts
    this.router.add("GET", "/api/alerts", (_req, res) => {
      this._json(res, 200, this.telemetryService.getAlerts());
    });

    // GET /api/missions
    this.router.add("GET", "/api/missions", (_req, res) => {
      this._json(res, 200, Array.from(this.missions.values()));
    });

    // POST /api/missions
    this.router.add("POST", "/api/missions", (req, res, body) => {
      const mission = this._createMission(body as Partial<Mission>);
      this.missions.set(mission.id, mission);
      this._addEvent("MISSION_START", "INFO", `Mission "${mission.name}" created`, { missionId: mission.id });
      this._broadcast({ type: "MISSION_STATE", payload: mission, timestamp: Date.now(), source: "server" });
      this._json(res, 201, mission);
    });

    // GET /api/missions/:id
    this.router.add("GET", "/api/missions/:id", (req, res) => {
      const id = this._extractId(req, "id");
      const mission = this.missions.get(id);
      if (!mission) {
        this._json(res, 404, { error: "Mission not found" });
        return;
      }
      this._json(res, 200, mission);
    });

    // PATCH /api/missions/:id/status
    this.router.add("PATCH", "/api/missions/:id/status", async (req, res, body) => {
      const id = this._extractId(req, "id");
      const mission = this.missions.get(id);
      if (!mission) {
        this._json(res, 404, { error: "Mission not found" });
        return;
      }
      const bodyObj = body as { status: MissionStatus };
      const oldStatus = mission.status;
      mission.status = bodyObj.status;
      if (bodyObj.status === "ACTIVE" && !mission.startedAt) {
        mission.startedAt = Date.now();
        this._addEvent("MISSION_START", "INFO", `Mission "${mission.name}" started`, { missionId: mission.id });
      }
      if (bodyObj.status === "COMPLETED") {
        mission.completedAt = Date.now();
        this._addEvent("MISSION_COMPLETE", "INFO", `Mission "${mission.name}" completed`, { missionId: mission.id });
      }
      if (bodyObj.status === "ABORTED") {
        this._addEvent("MISSION_ABORT", "WARNING", `Mission "${mission.name}" aborted`, { missionId: mission.id });
      }
      this._broadcast({ type: "MISSION_STATE", payload: mission, timestamp: Date.now(), source: "server" });
      this._json(res, 200, mission);
    });

    // GET /api/missions/:id/events
    this.router.add("GET", "/api/missions/:id/events", (req, res) => {
      const id = this._extractId(req, "id");
      const filtered = this.events.filter((e) => e.missionId === id);
      this._json(res, 200, filtered);
    });

    // GET /api/events
    this.router.add("GET", "/api/events", (_req, res) => {
      this._json(res, 200, this.events);
    });

    // GET /api/detections
    this.router.add("GET", "/api/detections", (_req, res) => {
      this._json(res, 200, this.detections);
    });

    // POST /api/detections
    this.router.add("POST", "/api/detections", (req, res, body) => {
      const det = body as Detection;
      det.id = det.id ?? uuid();
      det.timestamp = det.timestamp ?? Date.now();
      this.detections.push(det);
      // Keep only last 1000 detections
      if (this.detections.length > 1000) {
        this.detections = this.detections.slice(-1000);
      }
      this._addEvent("DETECTION", "INFO", `Detection: ${det.class} (${(det.confidence * 100).toFixed(1)}%)`, {
        detectionId: det.id,
        missionId: det.metadata?.missionId as string,
      });
      this._broadcast({ type: "DETECTION", payload: det, timestamp: Date.now(), source: "server" });
      this._json(res, 201, det);
    });

    // GET /api/system/health
    this.router.add("GET", "/api/system/health", (_req, res) => {
      const health: SystemHealth = {
        cpuPercent: 0,
        memoryMB: 0,
        visionInferenceMs: 0,
        videoFPS: 0,
        telemetryLatencyMs: 0,
        uptimeSeconds: Math.floor(process.uptime()),
      };
      this._json(res, 200, health);
    });

    // POST /api/simulator/config
    this.router.add("POST", "/api/simulator/config", (req, res, body) => {
      if (!this._simAdapter) {
        this._json(res, 400, { error: "Not in simulator mode" });
        return;
      }
      const config = body as Partial<SimulatorConfig>;
      if (config.startLatitude !== undefined) this._simAdapter._currentLat = config.startLatitude;
      if (config.startLongitude !== undefined) this._simAdapter._currentLon = config.startLongitude;
      if (config.startAltitude !== undefined) this._simAdapter._currentAlt = config.startAltitude;
      if (config.speedMps !== undefined) this._simAdapter.setSpeed(config.speedMps);
      this._json(res, 200, { status: "ok", config: this._simAdapter.config });
    });

    // POST /api/simulator/waypoints
    this.router.add("POST", "/api/simulator/waypoints", (req, res, body) => {
      if (!this._simAdapter) {
        this._json(res, 400, { error: "Not in simulator mode" });
        return;
      }
      const wps = body as Array<{ lat: number; lon: number; alt: number }>;
      this._simAdapter.setWaypoints(wps);
      this._json(res, 200, { status: "ok", waypoints: wps.length });
    });

    // POST /api/drone/connect
    this.router.add("POST", "/api/drone/connect", async (req, res) => {
      try {
        await this.droneAdapter.connect();
        this._json(res, 200, { status: "connected", droneId: this.droneAdapter.droneId });
      } catch (e) {
        this._json(res, 500, { error: String(e) });
      }
    });

    // POST /api/drone/disconnect
    this.router.add("POST", "/api/drone/disconnect", async (req, res) => {
      await this.droneAdapter.disconnect();
      this._json(res, 200, { status: "disconnected" });
    });

    // POST /api/drone/flight-mode
    this.router.add("POST", "/api/drone/flight-mode", async (req, res, body) => {
      const bodyObj = body as { mode: string };
      try {
        await this.droneAdapter.setFlightMode(bodyObj.mode as any);
        this._json(res, 200, { status: "ok", mode: bodyObj.mode });
      } catch (e) {
        this._json(res, 500, { error: String(e) });
      }
    });

    // POST /api/drone/rth
    this.router.add("POST", "/api/drone/rth", async (req, res) => {
      try {
        await this.droneAdapter.requestRTH();
        this._json(res, 200, { status: "rth_requested" });
      } catch (e) {
        this._json(res, 500, { error: String(e) });
      }
    });

    // POST /api/drone/land
    this.router.add("POST", "/api/drone/land", async (req, res) => {
      try {
        await this.droneAdapter.requestLand();
        this._json(res, 200, { status: "landing" });
      } catch (e) {
        this._json(res, 500, { error: String(e) });
      }
    });
  }

  // ── WebSocket ─────────────────────────────────────────────────────

  private _setupWebSocket(): void {
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      console.log("WebSocket client connected");

      // Send current state on connect
      const t = this.telemetryService.getTelemetry();
      if (t) {
        ws.send(JSON.stringify({ type: "TELEMETRY", payload: t, timestamp: Date.now(), source: "server" }));
      }

      ws.on("close", () => {
        this.clients.delete(ws);
        console.log("WebSocket client disconnected");
      });

      ws.on("error", () => {
        this.clients.delete(ws);
      });

      // Handle incoming messages
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as WSMessage;
          this._handleWsMessage(ws, msg);
        } catch {
          // ignore malformed messages
        }
      });
    });
  }

  private _handleWsMessage(ws: WebSocket, msg: WSMessage): void {
    switch (msg.type) {
      case "REQUEST_TELEMETRY":
        const t = this.telemetryService.getTelemetry();
        if (t) ws.send(JSON.stringify({ type: "TELEMETRY", payload: t, timestamp: Date.now(), source: "server" }));
        break;
      case "REQUEST_MISSIONS":
        ws.send(JSON.stringify({ type: "MISSIONS_LIST", payload: Array.from(this.missions.values()), timestamp: Date.now(), source: "server" }));
        break;
      case "REQUEST_ALERTS":
        ws.send(JSON.stringify({ type: "ALERTS_LIST", payload: this.telemetryService.getAlerts(), timestamp: Date.now(), source: "server" }));
        break;
      case "ACK_ALERT":
        // Mark alert as acknowledged
        break;
      case "MISSION_CONTROL":
        this._handleMissionControl(msg.payload as { action: string; missionId?: string });
        break;
    }
  }

  private _handleMissionControl(payload: { action: string; missionId?: string }): void {
    switch (payload.action) {
      case "START_MISSION":
        if (payload.missionId) {
          const m = this.missions.get(payload.missionId);
          if (m) {
            m.status = "ACTIVE";
            m.startedAt = Date.now();
            this._addEvent("MISSION_START", "INFO", `Mission "${m.name}" started`, { missionId: m.id });
            this._broadcast({ type: "MISSION_STATE", payload: m, timestamp: Date.now(), source: "server" });
          }
        }
        break;
      case "PAUSE_MISSION":
        if (payload.missionId) {
          const m = this.missions.get(payload.missionId);
          if (m) {
            m.status = "PAUSED";
            this._addEvent("MISSION_PAUSE", "WARNING", `Mission "${m.name}" paused`, { missionId: m.id });
            this._broadcast({ type: "MISSION_STATE", payload: m, timestamp: Date.now(), source: "server" });
          }
        }
        break;
      case "ABORT_MISSION":
        if (payload.missionId) {
          const m = this.missions.get(payload.missionId);
          if (m) {
            m.status = "ABORTED";
            this._addEvent("MISSION_ABORT", "ERROR", `Mission "${m.name}" aborted`, { missionId: m.id });
            this._broadcast({ type: "MISSION_STATE", payload: m, timestamp: Date.now(), source: "server" });
          }
        }
        break;
    }
  }

  // ── Broadcasting ──────────────────────────────────────────────────

  private _broadcast(message: WSMessage): void {
    const data = JSON.stringify(message);
    this.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private _json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private _extractId(req: http.IncomingMessage, param: string): string {
    const url = req.url ?? "";
    const match = url.match(new RegExp(`/api/[^/]+/(${param})`));
    return match?.[1] ?? "";
  }

  private _createMission(data: Partial<Mission>): Mission {
    return {
      id: data.id ?? uuid(),
      name: data.name ?? "Unnamed Mission",
      description: data.description ?? "",
      status: data.status ?? "PLANNED",
      droneId: data.droneId ?? this.droneAdapter.droneId,
      searchArea: data.searchArea,
      waypoints: data.waypoints ?? [],
      createdAt: Date.now(),
      detections: data.detections ?? [],
      warnings: data.warnings ?? [],
      estimatedDistanceMeters: data.estimatedDistanceMeters ?? 0,
      estimatedDurationSeconds: data.estimatedDurationSeconds ?? 0,
      coveragePercent: data.coveragePercent ?? 0,
      batteryEstimatePercent: data.batteryEstimatePercent ?? 100,
    };
  }

  private _addEvent(type: EventType, severity: Severity, message: string, metadata?: Record<string, unknown>): void {
    const evt: MissionEvent = {
      id: uuid(),
      missionId: metadata?.missionId as string ?? "",
      droneId: this.droneAdapter.droneId,
      type,
      severity,
      message,
      timestamp: Date.now(),
      metadata,
    };
    this.events.push(evt);
    // Keep last 1000 events
    if (this.events.length > 1000) {
      this.events = this.events.slice(-1000);
    }
  }

  private _startSimulationTick(): void {
    this._tickInterval = setInterval(() => {
      // Simulator generates its own telemetry via the adapter's interval.
      // This tick is for periodic server-side tasks.
    }, 1000);
  }

  private _stopSimulationTick(): void {
    if (this._tickInterval !== null) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }

  private _handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.router.handle(req, res);
  }
}
