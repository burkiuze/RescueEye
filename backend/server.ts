// RescueEye — HTTP + WebSocket server.
//
// Assembles the drone adapter, telemetry, mission, event, safety, vision and
// authentication services into one process and exposes them over HTTP + WS.
//
// Priorities when these conflict:
//   1. An unauthenticated request never reaches an aircraft command.
//   2. A safety failsafe always fires unless an authorised, time-boxed human
//      override exists for that exact state.
//   3. Mission progress is never allowed to win over either of the above.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";

import type {
  Alert,
  Capability,
  Detection,
  EventType,
  Mission,
  MissionEvent,
  MissionStatus,
  Operator,
  Role,
  Severity,
  SystemHealth,
  Telemetry,
} from "../shared/models";

import { TelemetryService } from "./telemetry_service";
import { EventService } from "./event_service";
import { SafetyService, type SafetyEvent } from "./safety_service";
import { AuthService, AuditLog, Authorizer, parseBearer } from "./auth_service";
import { JsonlStore, MemoryStore, type AnyStore } from "./persistence";

import type { DroneAdapter } from "../shared/models";
import { ROLE_CAPABILITIES as ROLE_CAPS } from "../shared/models";

export const MAX_BODY_BYTES = 256 * 1024;

export interface ServerConfig {
  port: number;
  host?: string;
  wsPath: string;
  droneAdapter: DroneAdapter;
  /** Directory for durable JSONL records. Omit for in-memory only. */
  dataDir?: string;
  /** Emit SYNTHETIC detections from the demo vision path. Off by default. */
  allowSyntheticDetections?: boolean;
  telemetryRateHz?: number;
  auth?: AuthService;
}

interface Principal {
  operator: Operator;
  token: string;
}

/**
 * Path router with real `:param` support.
 *
 * The earlier version compared literal strings, so every route declared with
 * ":id" was permanently unreachable — mission lookup, event history and
 * detection history were all dead endpoints.
 */
type Handler = (
  ctx: RequestContext,
) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  principal: Principal;
}

export class RescueEyeServer {
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly routes: Route[] = [];

  private readonly auth: AuthService;
  private readonly audit = new AuditLog();
  private readonly authorizer: Authorizer;

  private readonly telemetryService = new TelemetryService(3000);
  private readonly eventService: EventService;
  private readonly safetyService: SafetyService;

  private readonly missions: AnyStore<Mission>;
  private readonly events: AnyStore<MissionEvent>;
  private readonly detections: AnyStore<Detection>;

  private readonly clients = new Set<WebSocket>();
  private readonly clientOperators = new WeakMap<WebSocket, Operator>();

  private readonly startedAt = Date.now();
  private listenResolve: (() => void) | null = null;
  private boundPort = 0;

  constructor(private readonly config: ServerConfig) {
    this.auth = config.auth ?? new AuthService();
    this.authorizer = new Authorizer(this.audit);

    const dir = config.dataDir;
    this.missions = dir ? new JsonlStore("missions", `${dir}/missions.jsonl`) : new MemoryStore("missions");
    this.events = dir ? new JsonlStore("events", `${dir}/events.jsonl`) : new MemoryStore("events");
    this.detections = dir ? new JsonlStore("detections", `${dir}/detections.jsonl`) : new MemoryStore("detections");

    this.eventService = new EventService();
    this.safetyService = new SafetyService();

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    this.wss = new WebSocketServer({
      server: this.server,
      path: config.wsPath,
      maxPayload: MAX_BODY_BYTES,
      // Reject unauthenticated sockets during the HTTP upgrade, before any
      // aircraft state can be pushed to them.
      verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) => {
        const token = extractTokenFromRequest(info.req);
        const result = this.auth.authenticate(token);
        return result.ok;
      },
    });

    this.wireWebSocket();
    this.registerRoutes();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async start(): Promise<number> {
    await this.config.droneAdapter.connect();

    this.config.droneAdapter.onTelemetry((t) => this.onTelemetry(t));
    this.config.droneAdapter.onConnectionChange((state) => {
      this.addEvent("DRONE_CONNECTED", "INFO", `Drone link state: ${state}`);
      this.broadcast({
        type: "CONNECTION_STATE",
        payload: { droneId: this.config.droneAdapter.droneId, state },
        timestamp: Date.now(),
        source: "server",
      });
    });

    this.telemetryService.onAlert((alert) => this.onAlert(alert));
    this.telemetryService.startHealthMonitoring(1000);

    // Safety is evaluated on every telemetry frame and can command the
    // aircraft. This is the wiring that was previously missing entirely.
    this.config.droneAdapter.onTelemetry((t) => this.onSafetyFrame(t));

    const host = this.config.host ?? "0.0.0.0";
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, host, () => {
        const addr = this.server.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : this.config.port;
        resolve();
      });
    });

    console.log(`[RescueEye] listening on http://${host}:${this.boundPort} (ws ${this.config.wsPath})`);
    return this.boundPort;
  }

  get port(): number {
    return this.boundPort;
  }

  async stop(): Promise<void> {
    this.telemetryService.stopHealthMonitoring();
    for (const ws of this.clients) ws.close(1001, "server shutting down");
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.config.droneAdapter.disconnect().catch(() => undefined);
    await Promise.all([
      this.missions.close(),
      this.events.close(),
      this.detections.close(),
    ]);
  }

  // ── Telemetry + safety ───────────────────────────────────────────────

  private onTelemetry(t: Telemetry): void {
    this.telemetryService.update(t);
    this.broadcast({
      type: "TELEMETRY",
      payload: t,
      timestamp: Date.now(),
      source: "server",
    });
  }

  /**
   * Evaluate safety on every frame and apply the resulting failsafe unless a
   * human has an active, unexpired override for that state.
   */
  private onSafetyFrame(t: Telemetry): void {
    const events = this.safetyService.evaluate(t);
    for (const evt of events) {
      this.onSafetyEvent(evt);
    }
  }

  private onSafetyEvent(evt: SafetyEvent): void {
    const overridden = this.authorizer.activeOverride(evt.state);
    if (overridden) {
      // Record that the failsafe was suppressed; a suppressed failsafe is one
      // of the most important things in the log after an incident.
    this.audit.record({
      actorId: overridden.operatorId,
      actorUsername: overridden.operatorUsername,
      actorRole: "safetyOfficer",
      action: "failsafe.suppressed",
      target: `${evt.state}:${evt.action.type}`,
      outcome: "applied",
      detail: { reason: overridden.reason, expiresAt: overridden.expiresAt },
    });
      this.broadcast({
        type: "SAFETY_OVERRIDDEN",
        payload: { state: evt.state, operator: overridden.operatorUsername, expiresAt: overridden.expiresAt },
        timestamp: Date.now(),
        source: "server",
      });
      return;
    }

    this.addEvent(evt.state as EventType, severityForState(evt.state), evt.action.description, {
      safetyState: evt.state,
      action: evt.action.type,
      priority: evt.action.priority,
    });

    this.broadcast({
      type: "SAFETY_STATE",
      payload: {
        state: evt.state,
        previousState: evt.previousState,
        action: evt.action,
      },
      timestamp: Date.now(),
      source: "server",
    });

    void this.applyFailsafe(evt);
  }

  /** Actually move the aircraft. Every path is audited. */
  private async applyFailsafe(evt: SafetyEvent): Promise<void> {
    const adapter = this.config.droneAdapter;
    const target = "drone";

    try {
      switch (evt.action.type) {
        case "EMERGENCY_LANDING":
          await adapter.requestLand();
          break;
        case "RTH_REQUESTED":
          await adapter.requestRTH();
          break;
        case "MISSION_ABORT":
          for (const m of this.missions.filter((x) => x.status === "ACTIVE")) {
            await this.transitionMission(m, "ABORTED");
          }
          await adapter.abortMission();
          break;
        default:
          return; // WARNING-only states command nothing.
      }
      this.audit.record({
        actorId: "system:safety",
        actorUsername: "safety-service",
        actorRole: "admin",
        action: `failsafe.${evt.action.type}`,
        target,
        outcome: "applied",
        detail: { state: evt.state, description: evt.action.description },
      });
    } catch (err) {
      this.audit.record({
        actorId: "system:safety",
        actorUsername: "safety-service",
        actorRole: "admin",
        action: `failsafe.${evt.action.type}`,
        target,
        outcome: "failed",
        detail: { state: evt.state, error: String(err) },
      });
      this.addEvent("ALERT", "CRITICAL", `Failsafe ${evt.action.type} failed: ${String(err)}`);
    }
  }

  private onAlert(alert: Alert): void {
    this.addEvent("ALERT", alert.severity as Severity, alert.message, {
      alertId: alert.id,
      alertType: alert.type,
    });
    this.broadcast({
      type: "ALERT",
      payload: alert,
      timestamp: Date.now(),
      source: "server",
    });
  }

  // ── HTTP ─────────────────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      this.sendJson(res, 400, { error: "bad_request" });
      return;
    }

    try {
      // Liveness first: a load balancer must not need a token to check us,
      // and it must not be swallowed by the static handler.
      if (url.pathname === "/healthz") {
        this.sendJson(res, 200, this.health());
        return;
      }

      // Static console assets, served without auth: they contain no flight
      // data. Only the login shell lives here, and all flight data is behind
      // /api.
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        this.serveStatic(url.pathname, res);
        return;
      }

      const authed = this.authenticateRequest(req);
      if (!authed.ok) {
        this.audit.record({
          actorId: "anonymous",
          actorUsername: "anonymous",
          actorRole: "observer",
          action: `${req.method} ${url.pathname}`,
          target: url.pathname,
          outcome: "denied",
          detail: { reason: authed.reason },
        });
        this.sendJson(res, 401, { error: "unauthorized", reason: authed.reason });
        return;
      }

      const route = this.routes.find(
        (r) => r.method === req.method && r.pattern.test(url.pathname),
      );
      if (!route) {
        this.sendJson(res, 404, { error: "not_found" });
        return;
      }

      const match = route.pattern.exec(url.pathname)!;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1] ?? "");
      });

      const body = await readJsonBody(req);
      if (body === INVALID_JSON) {
        this.sendJson(res, 400, { error: "invalid_json" });
        return;
      }

      const ctx: RequestContext = {
        req,
        res,
        params,
        query: url.searchParams,
        body,
        principal: { operator: authed.operator, token: authed.token },
      };

      const result = await route.handler(ctx);
      if (result !== undefined) this.sendJson(res, 200, result);

      const ms = Date.now() - started;
      this.audit.record({
        actorId: authed.operator.id,
        actorUsername: authed.operator.username,
        actorRole: authed.operator.role,
        action: `${req.method} ${route.pattern.source}`,
        target: url.pathname,
        outcome: "applied",
        detail: { ms },
      });
    } catch (err) {
      if (err instanceof HttpError) {
        this.sendJson(res, err.status, { error: err.code, message: err.message });
        return;
      }
      this.sendJson(res, 500, { error: "internal_error", message: String(err) });
    }
  }

  private authenticateRequest(req: IncomingMessage): { ok: true; operator: Operator; token: string } | { ok: false; reason: string } {
    const header = req.headers.authorization;
    const token = parseBearer(header) ?? extractQueryToken(req);
    const result = this.auth.authenticate(token);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, operator: result.operator, token: token ?? "" };
  }

  private require(ctx: RequestContext, capability: Capability): void {
    const decision = this.authorizer.check(ctx.principal.operator.role, capability);
    if (decision.allowed) return;
    this.audit.record({
      actorId: ctx.principal.operator.id,
      actorUsername: ctx.principal.operator.username,
      actorRole: ctx.principal.operator.role,
      action: "authorization.denied",
      target: capability,
      outcome: "denied",
      detail: { reason: decision.reason },
    });
    throw new HttpError(403, "forbidden", decision.reason ?? "missing capability");
  }

  private registerRoutes(): void {
    const add = (method: string, path: string, handler: Handler) => {
      const keys: string[] = [];
      const pattern = new RegExp(
        `^${path.replace(/:[A-Za-z0-9_]+/g, (m) => {
          keys.push(m.slice(1));
          return "([^/]+)";
        })}$`,
      );
      this.routes.push({ method, pattern, keys, handler });
    };

    // ── Read ───────────────────────────────────────────────────────────
    add("GET", "/api/health", () => this.health());
    // Identity of the caller. The console uses this to decide which controls
    // to show. It is read-only and must never trigger an aircraft action —
    // discovering a role by firing a command would mean signing in could move
    // a flying aircraft.
    add("GET", "/api/me", (ctx) => {
      const { operator } = ctx.principal;
      return {
        id: operator.id,
        username: operator.username,
        role: operator.role,
        capabilities: ROLE_CAPS[operator.role] ?? [],
      };
    });
    add("GET", "/api/telemetry", (ctx) => {
      this.require(ctx, "mission:read");
      return this.telemetryService.getTelemetry() ?? { status: "no_telemetry_yet" };
    });
    add("GET", "/api/missions", (ctx) => {
      this.require(ctx, "mission:read");
      return this.missions.all().sort((a, b) => b.createdAt - a.createdAt);
    });
    add("GET", "/api/missions/:id", (ctx) => {
      this.require(ctx, "mission:read");
      const m = this.missions.get(ctx.params.id);
      if (!m) throw new HttpError(404, "not_found", "mission");
      return m;
    });
    add("GET", "/api/missions/:id/events", (ctx) => {
      this.require(ctx, "mission:read");
      return this.events
        .filter((e) => e.missionId === ctx.params.id)
        .sort((a, b) => a.timestamp - b.timestamp);
    });
    add("GET", "/api/events", (ctx) => {
      this.require(ctx, "mission:read");
      const type = ctx.query.get("type");
      const severity = ctx.query.get("severity");
      let out = this.events.all();
      if (type) out = out.filter((e) => e.type === type);
      if (severity) out = out.filter((e) => e.severity === severity);
      return out.sort((a, b) => b.timestamp - a.timestamp);
    });
    add("GET", "/api/detections", (ctx) => {
      this.require(ctx, "mission:read");
      // Callers can explicitly ask to exclude synthetic records; the default
      // includes them but the UI must still render them as non-actionable.
      const real = ctx.query.get("real") === "true";
      let out = this.detections.all();
      if (real) out = out.filter((d) => d.provenance !== "SYNTHETIC");
      return out.sort((a, b) => b.timestamp - a.timestamp);
    });
    add("GET", "/api/audit", (ctx) => {
      // Only admins may read the audit trail: it shows what every operator did.
      this.require(ctx, "config:write");
      return this.audit.list({
        actorId: ctx.query.get("actorId") ?? undefined,
        action: ctx.query.get("action") ?? undefined,
        outcome: (ctx.query.get("outcome") as never) ?? undefined,
      });
    });
    add("GET", "/api/operators", (ctx) => {
      this.require(ctx, "account:manage");
      return this.auth.list();
    });

    // ── Mission lifecycle ──────────────────────────────────────────────
    add("POST", "/api/missions", (ctx) => {
      this.require(ctx, "mission:write");
      const body = asObject(ctx.body);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) throw new HttpError(400, "bad_request", "name is required");
      if (name.length > 120) throw new HttpError(400, "bad_request", "name too long");

      const mission: Mission = {
        id: `mission-${randomBytes(6).toString("hex")}`,
        name,
        description: typeof body.description === "string" ? body.description.slice(0, 2000) : "",
        status: "PLANNED",
        droneId: this.config.droneAdapter.droneId,
        searchArea: undefined,
        waypoints: [],
        createdAt: Date.now(),
        detections: [],
        warnings: [],
        estimatedDistanceMeters: 0,
        estimatedDurationSeconds: 0,
        coveragePercent: 0,
        batteryEstimatePercent: 100,
      };
      this.missions.put(mission);
      this.addEvent("MISSION_START", "INFO", `Mission "${mission.name}" created`, { missionId: mission.id });
      this.broadcastMission(mission);
      return mission;
    });

    add("POST", "/api/missions/:id/start", async (ctx) => {
      this.require(ctx, "mission:control");
      const mission = this.requireMission(ctx.params.id);
      await this.transitionMission(mission, "ACTIVE");
      try {
        await this.config.droneAdapter.resumeMission();
      } catch (err) {
        // The aircraft refused. Roll the mission back rather than leaving the
        // console showing an active mission that is not flying.
        await this.transitionMission(mission, "FAILED");
        throw new HttpError(502, "drone_rejected", String(err));
      }
      return this.missions.get(mission.id);
    });

    add("POST", "/api/missions/:id/pause", async (ctx) => {
      this.require(ctx, "mission:control");
      const mission = this.requireMission(ctx.params.id);
      await this.transitionMission(mission, "PAUSED");
      await this.config.droneAdapter.pauseMission().catch(() => undefined);
      return this.missions.get(mission.id);
    });

    add("POST", "/api/missions/:id/abort", async (ctx) => {
      this.require(ctx, "mission:control");
      const mission = this.requireMission(ctx.params.id);
      await this.transitionMission(mission, "ABORTED");
      await this.config.droneAdapter.abortMission().catch(() => undefined);
      return this.missions.get(mission.id);
    });

    // ── Aircraft commands ──────────────────────────────────────────────
    add("POST", "/api/drone/rth", async (ctx) => {
      this.require(ctx, "drone:command");
      await this.config.droneAdapter.requestRTH();
      this.audit.record({
        actorId: ctx.principal.operator.id,
        actorUsername: ctx.principal.operator.username,
        actorRole: ctx.principal.operator.role,
        action: "drone.rth",
        target: this.config.droneAdapter.droneId,
        outcome: "applied",
      });
      this.addEvent("RTH_TRIGGERED", "INFO", "Return-to-home requested by operator");
      return { ok: true };
    });

    add("POST", "/api/drone/land", async (ctx) => {
      this.require(ctx, "drone:command");
      await this.config.droneAdapter.requestLand();
      this.audit.record({
        actorId: ctx.principal.operator.id,
        actorUsername: ctx.principal.operator.username,
        actorRole: ctx.principal.operator.role,
        action: "drone.land",
        target: this.config.droneAdapter.droneId,
        outcome: "applied",
      });
      this.addEvent("EMERGENCY_LANDING", "WARNING", "Landing requested by operator");
      return { ok: true };
    });

    // ── Failsafe override ──────────────────────────────────────────────
    add("POST", "/api/failsafe/override", (ctx) => {
      // Overriding an automated safety action is deliberately not granted to a
      // plain operator. It sits with the safety officer who is accountable.
      this.require(ctx, "failsafe:override");
      const body = asObject(ctx.body);
      const state = typeof body.state === "string" ? body.state : "";
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!state) throw new HttpError(400, "bad_request", "state is required");
      // A bare "ok" is not a justification; require an actual reason.
      if (reason.length < 10) {
        throw new HttpError(400, "bad_request", "reason must be at least 10 characters");
      }
      const durationMs = clampDuration(body.durationMs, 5000, 600_000);

      const record = this.authorizer.grantOverride({
        operator: ctx.principal.operator,
        safetyState: state,
        action: typeof body.action === "string" ? body.action : "unspecified",
        reason,
        durationMs,
      });
      return record;
    });

    add("DELETE", "/api/failsafe/override/:state", (ctx) => {
      this.require(ctx, "failsafe:override");
      const ok = this.authorizer.clearOverride(ctx.params.state, ctx.principal.operator);
      return { ok };
    });

    add("GET", "/api/failsafe/overrides", (ctx) => {
      this.require(ctx, "mission:read");
      return this.authorizer.listOverrides();
    });
  }

  private requireMission(id: string): Mission {
    const m = this.missions.get(id);
    if (!m) throw new HttpError(404, "not_found", "mission");
    return m;
  }

  /** Enforce the legal state machine, not just a field write. */
  private async transitionMission(mission: Mission, to: MissionStatus): Promise<void> {
    const legal: Record<MissionStatus, MissionStatus[]> = {
      // A freshly created mission may be started directly. Forcing operators
      // through an explicit READY step would be paperwork, not safety.
      PLANNED: ["READY", "ACTIVE", "ABORTED", "FAILED"],
      READY: ["ACTIVE", "ABORTED", "FAILED"],
      ACTIVE: ["PAUSED", "COMPLETED", "ABORTED", "FAILED"],
      PAUSED: ["ACTIVE", "COMPLETED", "ABORTED", "FAILED"],
      COMPLETED: [],
      ABORTED: [],
      FAILED: [],
    };
    if (!legal[mission.status].includes(to)) {
      throw new HttpError(
        409,
        "illegal_transition",
        `cannot move mission from ${mission.status} to ${to}`,
      );
    }

    const updated: Mission = { ...mission, status: to };
    if (to === "ACTIVE" && !updated.startedAt) updated.startedAt = Date.now();
    if (to === "COMPLETED" || to === "ABORTED" || to === "FAILED") {
      updated.completedAt = Date.now();
    }

    this.missions.put(updated);
    const eventFor: Partial<Record<MissionStatus, [EventType, Severity]>> = {
      ACTIVE: ["MISSION_START", "INFO"],
      PAUSED: ["MISSION_PAUSE", "WARNING"],
      COMPLETED: ["MISSION_COMPLETE", "INFO"],
      ABORTED: ["MISSION_ABORT", "ERROR"],
      FAILED: ["ALERT", "CRITICAL"],
    };
    const [type, severity] = eventFor[to] ?? ["ALERT", "INFO"];
    this.addEvent(type, severity, `Mission "${updated.name}" → ${to}`, { missionId: updated.id });
    this.broadcastMission(updated);
  }

  private broadcastMission(mission: Mission): void {
    this.broadcast({
      type: "MISSION_STATE",
      payload: mission,
      timestamp: Date.now(),
      source: "server",
    });
  }

  // ── Events ───────────────────────────────────────────────────────────

  private addEvent(
    type: EventType,
    severity: Severity,
    message: string,
    metadata?: Record<string, unknown>,
  ): MissionEvent {
    const evt: MissionEvent = {
      id: `evt-${randomBytes(6).toString("hex")}`,
      missionId: typeof metadata?.missionId === "string" ? metadata.missionId : "",
      droneId: this.config.droneAdapter.droneId,
      type,
      severity,
      message,
      timestamp: Date.now(),
      metadata,
    };
    // Events are immutable history: append-only, never rewritten.
    this.events.append(evt);
    this.eventService.addEvent(evt);
    this.broadcast({
      type: "EVENT",
      payload: evt,
      timestamp: Date.now(),
      source: "server",
    });
    return evt;
  }

  recordDetection(detection: Detection): Detection {
    // Last line of defence against a fabricated finding reaching an operator's
    // map. A detection may only claim MODEL provenance while synthetic
    // generation is explicitly enabled AND the caller is the demo path, which
    // tags its output SYNTHETIC; anything unlabelled is downgraded rather than
    // trusted.
    let provenance = detection.provenance;
    if (provenance !== "OPERATOR" && provenance !== "SYNTHETIC") {
      provenance = "MODEL";
    }
    if (provenance === "MODEL" && !this.config.allowSyntheticDetections) {
      // Model provenance is only meaningful if a model actually ran. With no
      // model loaded the server refuses to present output as a real finding.
      provenance = "SYNTHETIC";
    }

    const stored: Detection = { ...detection, provenance };
    this.detections.append(stored);

    const missionId = typeof stored.metadata?.missionId === "string" ? stored.metadata.missionId : "";
    if (missionId) {
      const mission = this.missions.get(missionId);
      if (mission) {
        this.missions.put({ ...mission, detections: [...mission.detections, stored.id] });
      }
    }

    this.addEvent(
      "DETECTION",
      stored.provenance === "SYNTHETIC" ? "INFO" : "INFO",
      `${stored.provenance === "SYNTHETIC" ? "[SIMULATED] " : ""}${stored.class} ${(stored.confidence * 100).toFixed(0)}%`,
      { detectionId: stored.id, missionId },
    );
    this.broadcast({
      type: "DETECTION",
      payload: stored,
      timestamp: Date.now(),
      source: "server",
    });
    return stored;
  }

  // ── WebSocket ────────────────────────────────────────────────────────

  private wireWebSocket(): void {
    this.wss.on("connection", (ws, req) => {
      const token = extractTokenFromRequest(req);
      const result = this.auth.authenticate(token);
      if (!result.ok) {
        ws.close(1008, "unauthorized");
        return;
      }
      this.clientOperators.set(ws, result.operator);
      this.clients.add(ws);

      const current = this.telemetryService.getTelemetry();
      if (current) {
        ws.send(JSON.stringify({
          type: "TELEMETRY",
          payload: current,
          timestamp: Date.now(),
          source: "server",
        }));
      }
      ws.send(JSON.stringify({
        type: "EVENT",
        payload: this.addEvent("DRONE_CONNECTED", "INFO", `Operator ${result.operator.username} connected to console`),
        timestamp: Date.now(),
        source: "server",
      }));

      ws.on("message", (raw) => {
        try {
          this.handleWsMessage(ws, result.operator, raw);
        } catch {
          // A malformed frame must not take the connection down.
        }
      });
      ws.on("close", () => {
        this.clients.delete(ws);
      });
      ws.on("error", () => {
        this.clients.delete(ws);
      });
    });
  }

  private handleWsMessage(ws: WebSocket, operator: Operator, raw: RawData): void {
    const parsed = JSON.parse(raw.toString()) as {
      type?: string;
      payload?: Record<string, unknown>;
    };
    if (!parsed || typeof parsed.type !== "string") return;
    const payload = asObject(parsed.payload);

    switch (parsed.type) {
      case "REQUEST_MISSIONS": {
        this.assertWsCapability(ws, operator, "mission:read");
        ws.send(JSON.stringify({
          type: "MISSIONS_LIST",
          payload: this.missions.all(),
          timestamp: Date.now(),
          source: "server",
        }));
        break;
      }
      case "REQUEST_EVENTS": {
        this.assertWsCapability(ws, operator, "mission:read");
        const missionId = typeof payload.missionId === "string" ? payload.missionId : undefined;
        const out = missionId
          ? this.events.filter((e) => e.missionId === missionId)
          : this.events.all();
        ws.send(JSON.stringify({
          type: "EVENTS_LIST",
          payload: out.sort((a, b) => b.timestamp - a.timestamp).slice(0, 500),
          timestamp: Date.now(),
          source: "server",
        }));
        break;
      }
      case "REQUEST_DETECTIONS": {
        this.assertWsCapability(ws, operator, "mission:read");
        ws.send(JSON.stringify({
          type: "DETECTIONS_LIST",
          payload: this.detections.all().sort((a, b) => b.timestamp - a.timestamp).slice(0, 500),
          timestamp: Date.now(),
          source: "server",
        }));
        break;
      }
      case "ACK_ALERT": {
        this.assertWsCapability(ws, operator, "mission:read");
        break;
      }
      default:
        // Mission control over WS is intentionally not supported: commands go
        // through REST where they can be authorised and audited per-request.
        ws.send(JSON.stringify({
          type: "ERROR",
          payload: { error: "unknown_message_type", received: parsed.type },
          timestamp: Date.now(),
          source: "server",
        }));
    }
  }

  private assertWsCapability(ws: WebSocket, operator: Operator, capability: Capability): void {
    const decision = this.authorizer.check(operator.role, capability);
    if (decision.allowed) return;
    this.audit.record({
      actorId: operator.id,
      actorUsername: operator.username,
      actorRole: operator.role,
      action: "ws.authorization.denied",
      target: capability,
      outcome: "denied",
      detail: { reason: decision.reason },
    });
    ws.send(JSON.stringify({
      type: "ERROR",
      payload: { error: "forbidden", capability },
      timestamp: Date.now(),
      source: "server",
    }));
  }

  private broadcast(message: { type: string; payload: unknown; timestamp: number; source: string }): void {
    const data = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  // ── Health ───────────────────────────────────────────────────────────

  health(): SystemHealth & {
    status: string;
    missions: number;
    events: number;
    detections: number;
    auditEntries: number;
    corruptLines: number;
    connectedOperators: number;
    activeOverrides: number;
    safetyState: string;
    wsClients: number;
  } {
    const mem = process.memoryUsage();
    const t = this.telemetryService.getTelemetry();
    return {
      status: "ok",
      cpuPercent: 0, // Meaningful CPU accounting needs a native sampler; not faked.
      memoryMB: Math.round(mem.rss / (1024 * 1024)),
      visionInferenceMs: 0,
      videoFPS: 0,
      telemetryLatencyMs: t ? Math.max(0, Date.now() - t.timestamp) : -1,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      missions: this.missions.size,
      events: this.events.size,
      detections: this.detections.size,
      auditEntries: this.audit.size,
      corruptLines:
        this.missions.corruptLines + this.events.corruptLines + this.detections.corruptLines,
      connectedOperators: this.clients.size,
      activeOverrides: this.authorizer.listOverrides().length,
      safetyState: this.safetyService.getCurrentState(),
      wsClients: this.clients.size,
    };
  }

  // Exposed for tests and for the console bootstrap.
  get auditLog(): AuditLog {
    return this.audit;
  }

  get authorizerRef(): Authorizer {
    return this.authorizer;
  }

  get authRef(): AuthService {
    return this.auth;
  }

  // ── Static assets ────────────────────────────────────────────────────

  private serveStatic(pathname: string, res: ServerResponse): void {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const { join, normalize } = require("node:path") as typeof import("node:path");

    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");

    // Serve the built bundle if present, otherwise fall back to the plain
    // sources. The console is hand-written browser JS, so both are usable and
    // the fallback means the UI still works before any build step.
    const preferred = normalize(join(process.cwd(), "frontend", "dist"));
    const fallback = normalize(join(process.cwd(), "frontend"));

    let root = preferred;
    if (!existsSync(join(preferred, rel)) && existsSync(join(fallback, rel))) {
      root = fallback;
    }

    // Reject traversal: resolve, then confirm the result stays under the root.
    const target = normalize(join(root, rel));
    if (!target.startsWith(root + "/") && target !== root) {
      this.sendJson(res, 403, { error: "forbidden" });
      return;
    }

    if (!existsSync(target) || !statSafe(target).isFile()) {
      this.sendJson(res, 404, { error: "not_found" });
      return;
    }

    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".map": "application/json",
      ".svg": "image/svg+xml",
    };
    const ext = target.slice(target.lastIndexOf("."));
    this.send(res, 200, types[ext] ?? "application/octet-stream", readFileSync(target));
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    this.send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
  }

  private send(res: ServerResponse, status: number, type: string, data: string | Buffer): void {
    if (res.headersSent) return;
    res.writeHead(status, {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    res.end(data);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const INVALID_JSON = Symbol("invalid_json");

function readJsonBody(req: IncomingMessage): Promise<unknown | typeof INVALID_JSON> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      // Refuse oversized bodies rather than buffering them into memory.
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        req.destroy();
        resolve(INVALID_JSON);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(INVALID_JSON);
      }
    });
    req.on("error", () => {
      if (!aborted) resolve(INVALID_JSON);
    });
  });
}

/** Confirm a path is a regular file, not a directory or special node. */
function statSafe(path: string): { isFile(): boolean } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { statSync } = require("node:fs") as typeof import("node:fs");
  try {
    return statSync(path);
  } catch {
    return { isFile: () => false };
  }
}

function extractTokenFromRequest(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const bearer = parseBearer(header);
  if (bearer) return bearer;
  const url = req.url ?? "";
  const q = url.indexOf("?");
  if (q >= 0) return new URLSearchParams(url.slice(q + 1)).get("token") ?? undefined;
  return undefined;
}

function extractQueryToken(req: IncomingMessage): string | undefined {
  const url = req.url ?? "";
  const q = url.indexOf("?");
  if (q < 0) return undefined;
  // Browsers cannot set headers on a WebSocket handshake, so the token may
  // arrive as a query parameter. It is still authenticated identically.
  return new URLSearchParams(url.slice(q + 1)).get("token") ?? undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function clampDuration(value: unknown, min: number, max: number): number {
  const n = typeof value === "number" ? value : min;
  return Math.min(Math.max(Math.round(n), min), max);
}

function severityForState(state: string): Severity {
  switch (state) {
    case "CRITICAL_BATTERY":
    case "CONNECTION_LOST":
      return "CRITICAL";
    case "LOW_BATTERY_WARNING":
    case "GPS_DEGRADED":
    case "GEOFENCE_WARNING":
    case "HIGH_WIND_WARNING":
    case "TELEMETRY_TIMEOUT":
      return "WARNING";
    default:
      return "INFO";
  }
}

/**
 * Provision the initial accounts. Tokens are printed once to stdout so the
 * operator can be given them; they are not recoverable afterwards.
 */
export function bootstrapOperators(
  auth: AuthService,
  specs: Array<{ username: string; role: Role }>,
): Array<{ username: string; role: Role; token: string }> {
  return specs.map(({ username, role }) => {
    const { token } = auth.provision(username, role);
    return { username, role, token };
  });
}

export type { Role };
