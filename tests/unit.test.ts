// RescueEye — unit tests for the safety-critical building blocks.
//
// These cover the pieces where a subtle bug would put an aircraft somewhere it
// should not be: the state machine, the failsafe evaluator, token handling and
// the detection provenance rules. Server/transport behaviour lives in
// integration.test.ts, which starts a real listener and speaks real HTTP+WS.

import { SafetyService } from "../backend/safety_service";
import { AuthService, AuditLog, Authorizer, parseBearer, constantTimeEquals } from "../backend/auth_service";
import { JsonlStore, MemoryStore } from "../backend/persistence";
import { SimulatorDroneAdapter } from "../simulator/simulator_adapter";
import { TelemetryService } from "../backend/telemetry_service";
import { MissionManager, InMemoryMissionStore, InMemoryEventStore } from "../backend/mission_service";
import {
  DetectionService,
  SyntheticModel,
  OnnxDetectionModel,
  nonMaxSuppression,
  iou,
  decodeFlatOutput,
  type Frame,
} from "../vision/detection";
import { FrameBuffer } from "../vision/camera_pipeline";
import { roleHasCapability, type Telemetry, type Operator } from "../shared/models";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function telemetry(over: Partial<Telemetry> = {}): Telemetry {
  return {
    droneId: "d1",
    latitude: 37.7749,
    longitude: -122.4194,
    altitude: 50,
    relativeAltitude: 10,
    heading: 90,
    groundSpeed: 5,
    verticalSpeed: 0,
    pitch: 0,
    roll: 0,
    yaw: 90,
    batteryPercentage: 85,
    voltage: 12.6,
    gpsFix: true,
    satelliteCount: 12,
    flightMode: "AUTO",
    connectionState: "CONNECTED",
    homeLatitude: 37.7749,
    homeLongitude: -122.4194,
    homeAltitude: 50,
    flightDurationSeconds: 120,
    distanceFromHomeMeters: 300,
    timestamp: Date.now(),
    ...over,
  };
}

// ── Roles and capabilities ─────────────────────────────────────────────

describe("role capabilities", () => {
  test("observer cannot command", () => {
    expect(roleHasCapability("observer", "mission:read")).toBe(true);
    expect(roleHasCapability("observer", "mission:control")).toBe(false);
    expect(roleHasCapability("observer", "drone:command")).toBe(false);
  });

  test("operator can run missions but not command the aircraft directly", () => {
    expect(roleHasCapability("operator", "mission:control")).toBe(true);
    expect(roleHasCapability("operator", "drone:command")).toBe(false);
  });

  test("only safety officer may override a failsafe", () => {
    expect(roleHasCapability("operator", "failsafe:override")).toBe(false);
    expect(roleHasCapability("safetyOfficer", "failsafe:override")).toBe(true);
  });

  test("admin is not automatically a flight authority", () => {
    // Admins manage accounts/config; they must not inherit aircraft control.
    expect(roleHasCapability("admin", "drone:command")).toBe(false);
    expect(roleHasCapability("admin", "mission:control")).toBe(false);
    expect(roleHasCapability("admin", "account:manage")).toBe(true);
  });
});

// ── Auth ───────────────────────────────────────────────────────────────

describe("AuthService", () => {
  let auth: AuthService;

  beforeEach(() => {
    auth = new AuthService();
  });

  test("accepts a provisioned token", () => {
    const { token } = auth.provision("op", "operator");
    const res = auth.authenticate(token);
    expect(res.ok).toBe(true);
  });

  test("rejects a missing token", () => {
    expect(auth.authenticate(undefined)).toMatchObject({ ok: false, reason: "missing_token" });
    expect(auth.authenticate("")).toMatchObject({ ok: false, reason: "missing_token" });
  });

  test("rejects a wrong token", () => {
    auth.provision("op", "operator");
    expect(auth.authenticate("not-the-token")).toMatchObject({ ok: false, reason: "invalid_token" });
  });

  test("rejects a token that shares a prefix with a real one", () => {
    const { token } = auth.provision("op", "operator");
    expect(auth.authenticate(token.slice(0, token.length - 1)).ok).toBe(false);
  });

  test("tokens do not cross over between operators", () => {
    const a = auth.provision("a", "operator");
    const b = auth.provision("b", "safetyOfficer");
    expect(auth.authenticate(a.token).ok && (auth.authenticate(a.token) as any).operator.username).toBe("a");
    expect((auth.authenticate(b.token) as any).operator.username).toBe("b");
  });

  test("disabled operator is rejected even with a valid token", () => {
    const { operator, token } = auth.provision("op", "operator");
    auth.disable(operator.id);
    expect(auth.authenticate(token)).toMatchObject({ ok: false, reason: "disabled" });
  });

  test("provisioned token is not recoverable from the operator record", () => {
    const { token, operator } = auth.provision("op", "operator");
    const serialised = JSON.stringify(auth.list());
    expect(serialised).not.toContain(token);
    expect(operator).not.toHaveProperty("token");
    expect(operator).not.toHaveProperty("tokenHash");
  });
});

describe("parseBearer", () => {
  test("parses a well formed header", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer("bearer abc123")).toBe("abc123");
  });

  test("rejects anything else", () => {
    expect(parseBearer("abc123")).toBeUndefined();
    expect(parseBearer("Basic abc")).toBeUndefined();
    expect(parseBearer(undefined)).toBeUndefined();
    expect(parseBearer(null)).toBeUndefined();
  });
});

describe("constantTimeEquals", () => {
  test("matches identical strings", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
  });

  test("rejects different strings", () => {
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
    expect(constantTimeEquals("", "a")).toBe(false);
  });
});

// ── Authorizer / overrides ─────────────────────────────────────────────

describe("Authorizer overrides", () => {
  const op: Operator = { id: "u1", username: "safety1", role: "safetyOfficer", createdAt: 0 };

  test("override is not active before it is granted", () => {
    const a = new Authorizer(new AuditLog());
    expect(a.isOverridden("LOW_BATTERY_WARNING")).toBe(false);
  });

  test("override suppresses a failsafe until it expires", () => {
    const a = new Authorizer(new AuditLog());
    a.grantOverride({
      operator: op,
      safetyState: "LOW_BATTERY_WARNING",
      action: "RTH_REQUESTED",
      reason: "ground team confirming survivor location",
      durationMs: 50,
    });
    expect(a.isOverridden("LOW_BATTERY_WARNING")).toBe(true);
  });

  test("expired override stops suppressing", async () => {
    const a = new Authorizer(new AuditLog());
    a.grantOverride({
      operator: op,
      safetyState: "LOW_BATTERY_WARNING",
      action: "RTH_REQUESTED",
      reason: "short window only",
      durationMs: 20,
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(a.isOverridden("LOW_BATTERY_WARNING")).toBe(false);
  });

  test("override applies to one state only", () => {
    const a = new Authorizer(new AuditLog());
    a.grantOverride({
      operator: op,
      safetyState: "LOW_BATTERY_WARNING",
      action: "RTH",
      reason: "acknowledged, returning manually",
      durationMs: 10_000,
    });
    // A different safety state must not be suppressed by an unrelated override.
    expect(a.isOverridden("CRITICAL_BATTERY")).toBe(false);
  });

  test("granting an override is audited", () => {
    const audit = new AuditLog();
    const a = new Authorizer(audit);
    a.grantOverride({
      operator: op,
      safetyState: "GPS_DEGRADED",
      action: "WARNING",
      reason: "visual navigation until GPS recovers",
      durationMs: 60_000,
    });
    const entries = audit.list({ action: "failsafe.override.grant" });
    expect(entries).toHaveLength(1);
    expect(entries[0].actorUsername).toBe("safety1");
  });

  test("override can be cleared early", () => {
    const a = new Authorizer(new AuditLog());
    a.grantOverride({ operator: op, safetyState: "GPS_DEGRADED", action: "W", reason: "temporary", durationMs: 60_000 });
    expect(a.clearOverride("GPS_DEGRADED", op)).toBe(true);
    expect(a.isOverridden("GPS_DEGRADED")).toBe(false);
  });
});

// ── Audit log ──────────────────────────────────────────────────────────

describe("AuditLog", () => {
  test("records denials as well as approvals", () => {
    const audit = new AuditLog();
    audit.record({
      actorId: "u1", actorUsername: "bob", actorRole: "observer",
      action: "drone.rth", target: "d1", outcome: "denied",
    });
    expect(audit.list({ outcome: "denied" })).toHaveLength(1);
  });

  test("is bounded so it cannot exhaust memory", () => {
    const audit = new AuditLog(10);
    for (let i = 0; i < 100; i++) {
      audit.record({
        actorId: "u", actorUsername: "u", actorRole: "operator",
        action: "x", target: "t", outcome: "applied",
      });
    }
    expect(audit.size).toBe(10);
  });

  test("entries are stamped with id and time", () => {
    const audit = new AuditLog();
    const e = audit.record({
      actorId: "u", actorUsername: "u", actorRole: "operator",
      action: "x", target: "t", outcome: "applied",
    });
    expect(e.id).toMatch(/^aud-/);
    expect(typeof e.at).toBe("number");
  });
});

// ── Safety ─────────────────────────────────────────────────────────────

describe("SafetyService", () => {
  let svc: SafetyService;

  beforeEach(() => {
    svc = new SafetyService();
  });

  test("normal flight produces no safety events", () => {
    expect(svc.evaluate(telemetry())).toHaveLength(0);
    expect(svc.getCurrentState()).toBe("NORMAL");
  });

  test("critical battery demands an immediate action", () => {
    const events = svc.evaluate(telemetry({ batteryPercentage: 3 }));
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].state).toBe("CRITICAL_BATTERY");
    expect(events[0].action.type).toBe("EMERGENCY_LANDING");
  });

  test("low battery recommends RTH but not an immediate landing", () => {
    const events = svc.evaluate(telemetry({ batteryPercentage: 15 }));
    expect(events[0].state).toBe("LOW_BATTERY_WARNING");
    expect(events[0].action.type).toBe("RTH_REQUESTED");
  });

  test("lost connection is critical and produces a dispatchable action", () => {
    const events = svc.evaluate(telemetry({ connectionState: "LOST" }));
    expect(events[0].state).toBe("CONNECTION_LOST");
    expect(events[0].action.priority).toBeLessThanOrEqual(2);
    // The action type must be one the server's applyFailsafe can actually
    // dispatch. It was "CRITICAL" — a severity word, not an action — so the
    // abort branch never ran and a lost link left the mission flying
    // unattended. Asserting only on priority would not have caught that.
    expect(["MISSION_ABORT", "RTH_REQUESTED", "EMERGENCY_LANDING"]).toContain(
      events[0].action.type,
    );
  });

  test("stale telemetry raises TELEMETRY_TIMEOUT", () => {
    // telemetryTimeoutMs was configured but never read, so a stream that
    // simply stopped produced no safety event whatsoever.
    const strict = new SafetyService({ telemetryTimeoutMs: 1000 });
    const events = strict.evaluate(telemetry({ timestamp: Date.now() - 30_000 }));
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].state).toBe("TELEMETRY_TIMEOUT");
    expect(["MISSION_ABORT", "RTH_REQUESTED"]).toContain(events[0].action.type);
  });

  test("fresh telemetry does not trip the timeout", () => {
    const strict = new SafetyService({ telemetryTimeoutMs: 1000 });
    expect(strict.evaluate(telemetry())).toHaveLength(0);
  });

  test("a genuine transition is never swallowed by the repeat cooldown", () => {
    // Cooldown suppresses a *held* condition re-firing each frame. It must not
    // suppress the moment the state actually changes, or the operator sees the
    // safety indicator move with no event explaining why.
    const seq = new SafetyService();
    seq.evaluate(telemetry({ batteryPercentage: 3 }));   // emits CRITICAL_BATTERY
    seq.evaluate(telemetry({ batteryPercentage: 90 }));  // clears to NORMAL
    const events = seq.evaluate(telemetry({ gpsFix: false, satelliteCount: 2 }));
    expect(events.some((e) => e.state === "GPS_DEGRADED")).toBe(true);
  });

  test("a held condition does not re-emit on every frame", () => {
    // The other half of the rule: without cooldown, a 3% pack at 10 Hz floods
    // the event log (4922 events in 29 seconds) and buries the screen.
    const held = new SafetyService();
    const first = held.evaluate(telemetry({ batteryPercentage: 3 }));
    expect(first.length).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) {
      expect(held.evaluate(telemetry({ batteryPercentage: 3 }))).toHaveLength(0);
    }
  });

  test("degraded GPS is flagged", () => {
    const events = svc.evaluate(telemetry({ gpsFix: false, satelliteCount: 2 }));
    expect(events.some((e) => e.state === "GPS_DEGRADED")).toBe(true);
  });

  test("geofence breach is flagged", () => {
    const svc2 = new SafetyService({ maxDistanceFromHomeMeters: 1000 });
    const events = svc2.evaluate(telemetry({ distanceFromHomeMeters: 2500 }));
    expect(events.some((e) => e.state === "GEOFENCE_WARNING")).toBe(true);
  });

  test("state recovers once the condition clears", () => {
    svc.evaluate(telemetry({ batteryPercentage: 15 }));
    expect(svc.getCurrentState()).toBe("LOW_BATTERY_WARNING");
    svc.evaluate(telemetry({ batteryPercentage: 60 }));
    expect(svc.getCurrentState()).toBe("NORMAL");
  });

  test("an event can be acknowledged", () => {
    const [evt] = svc.evaluate(telemetry({ batteryPercentage: 3 }));
    expect(svc.acknowledgeEvent(evt.id)).toBe(true);
    expect(svc.getEvents().find((e) => e.id === evt.id)?.acknowledged).toBe(true);
  });

  test("critical battery outranks a concurrent low-battery warning", () => {
    // Both conditions hold at once; the more dangerous one must win.
    const events = svc.evaluate(telemetry({ batteryPercentage: 2 }));
    expect(events[0].state).toBe("CRITICAL_BATTERY");
    expect(svc.getCurrentState()).toBe("CRITICAL_BATTERY");
  });
});

// ── Telemetry alerts ───────────────────────────────────────────────────

describe("TelemetryService alerts", () => {
  function alertTypes(bat = 85, sats = 12, fix = true, conn = "CONNECTED"): string[] {
    const svc = new TelemetryService(5000);
    const seen: string[] = [];
    svc.onAlert((a) => seen.push(a.type));
    svc.update(telemetry({ batteryPercentage: bat, satelliteCount: sats, gpsFix: fix, connectionState: conn as any }));
    return seen;
  }

  test("healthy telemetry is silent", () => {
    expect(alertTypes()).toHaveLength(0);
  });

  test("low battery raises an alert", () => {
    expect(alertTypes(15)).toContain("LOW_BATTERY");
  });

  test("critical battery escalates severity", () => {
    expect(alertTypes(3)).toContain("CRITICAL_BATTERY");
  });

  test("GPS loss raises an alert", () => {
    expect(alertTypes(85, 2, false)).toContain("GPS_DEGRADED");
  });

  test("lost link raises an alert", () => {
    expect(alertTypes(85, 12, true, "LOST")).toContain("CONNECTION_LOST");
  });

  test("alert list is bounded", () => {
    const svc = new TelemetryService(5000);
    for (let i = 0; i < 250; i++) {
      svc.update(telemetry({ batteryPercentage: 5 }));
    }
    expect(svc.getAlerts().length).toBeLessThanOrEqual(100);
  });

  test("no telemetry means not connected", () => {
    const svc = new TelemetryService(5000);
    expect(svc.isConnected()).toBe(false);
    expect(svc.getConnectionState()).toBe("DISCONNECTED");
  });
});

// ── Mission state machine ──────────────────────────────────────────────

describe("MissionManager state machine", () => {
  function mgr() {
    return new MissionManager({
      missionStore: new InMemoryMissionStore(),
      eventStore: new InMemoryEventStore(),
      waypointPlanner: {
        planSearchArea: () => ({ waypoints: [], estimatedDistanceMeters: 0, estimatedDurationSeconds: 0 }),
      },
    });
  }

  test("a new mission is PLANNED", () => {
    const m = mgr().createMission({ name: "Sweep", droneId: "d1" });
    expect(m.status).toBe("PLANNED");
  });

  test("PLANNED -> ACTIVE -> COMPLETED is legal", () => {
    const m = mgr();
    const mission = m.createMission({ name: "Sweep", droneId: "d1" });
    expect(m.startMission(mission.id)?.status).toBe("ACTIVE");
    expect(m.completeMission(mission.id)?.status).toBe("COMPLETED");
    expect(m.getMission(mission.id)?.completedAt).toBeDefined();
  });

  test("ACTIVE -> PAUSED -> ACTIVE is legal", () => {
    const m = mgr();
    const mission = m.createMission({ name: "Sweep", droneId: "d1" });
    m.startMission(mission.id);
    expect(m.pauseMission(mission.id)?.status).toBe("PAUSED");
    expect(m.resumeMission(mission.id)?.status).toBe("ACTIVE");
  });

  test("cannot pause a mission that was never started", () => {
    const m = mgr();
    const mission = m.createMission({ name: "Sweep", droneId: "d1" });
    expect(m.pauseMission(mission.id)).toBeUndefined();
  });

  test("cannot restart a completed mission", () => {
    const m = mgr();
    const mission = m.createMission({ name: "Sweep", droneId: "d1" });
    m.startMission(mission.id);
    m.completeMission(mission.id);
    expect(m.startMission(mission.id)).toBeUndefined();
  });

  test("abort is always available", () => {
    const m = mgr();
    const mission = m.createMission({ name: "Sweep", droneId: "d1" });
    expect(m.abortMission(mission.id)?.status).toBe("ABORTED");
  });

  test("state changes are written to the event log", () => {
    const events = new InMemoryEventStore();
    const m = new MissionManager({
      missionStore: new InMemoryMissionStore(),
      eventStore: events,
      waypointPlanner: { planSearchArea: () => ({ waypoints: [], estimatedDistanceMeters: 0, estimatedDurationSeconds: 0 }) },
    });
    const mission = m.createMission({ name: "Sweep", droneId: "d1" });
    m.startMission(mission.id);
    const types = events.getEvents(mission.id).map((e) => e.type);
    expect(types).toContain("MISSION_START");
  });
});

// ── Persistence ────────────────────────────────────────────────────────

describe("JsonlStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rescueeye-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("survives a reload", () => {
    const path = join(dir, "missions.jsonl");
    const a = new JsonlStore<{ id: string; name: string }>("missions", path);
    a.put({ id: "m1", name: "North ridge sweep" });
    return a.close().then(() => {
      const b = new JsonlStore<{ id: string; name: string }>("missions", path);
      expect(b.get("m1")?.name).toBe("North ridge sweep");
      return b.close();
    });
  });

  test("a truncated final line does not lose earlier records", () => {
    const path = join(dir, "events.jsonl");
    const a = new JsonlStore<{ id: string }>("events", path);
    a.put({ id: "e1" });
    return a.close().then(() => {
      // Simulate a crash mid-write.
      require("node:fs").appendFileSync(path, '{"id":"e2","mes');
      const b = new JsonlStore<{ id: string }>("events", path);
      expect(b.get("e1")).toBeDefined();
      expect(b.corruptLines).toBeGreaterThan(0);
      return b.close();
    });
  });

  test("update replaces in place", () => {
    const s = new MemoryStore<{ id: string; v: number }>("missions");
    s.put({ id: "m1", v: 1 });
    s.put({ id: "m1", v: 2 });
    expect(s.size).toBe(1);
    expect(s.get("m1")?.v).toBe(2);
  });
});

// ── Detection ──────────────────────────────────────────────────────────

describe("Detection provenance", () => {
  test("synthetic model output is never presented as a real finding", async () => {
    const svc = new DetectionService(new SyntheticModel());
    await svc.initialize();
    expect(svc.provenance).toBe("SYNTHETIC");
    const dets = svc.processFrame(
      { data: Buffer.alloc(16), width: 8, height: 8, timestamp: Date.now(), format: "RGB24" },
      { sourceDroneId: "d1" },
    );
    for (const d of dets) expect(d.provenance).toBe("SYNTHETIC");
  });

  test("getRealDetections excludes synthetic output", async () => {
    const svc = new DetectionService(new SyntheticModel());
    await svc.initialize();
    svc.processFrame(
      { data: Buffer.alloc(16), width: 8, height: 8, timestamp: Date.now(), format: "RGB24" },
      { sourceDroneId: "d1" },
    );
    expect(svc.getRealDetections()).toHaveLength(0);
  });

  test("an ONNX model with no runtime refuses to load", async () => {
    const model = new OnnxDetectionModel({ modelPath: "/models/det.onnx" });
    await expect(model.load()).rejects.toThrow(/no InferenceRuntime/);
    expect(model.isLoaded()).toBe(false);
  });

  test("a loaded real model reports MODEL provenance", async () => {
    const runtime = { run: async () => new Float32Array(0) };
    const model = new OnnxDetectionModel({ modelPath: "/models/det.onnx", runtime });
    await model.load();
    const svc = new DetectionService(model);
    await svc.initialize();
    expect(svc.provenance).toBe("MODEL");
  });

  test("detection retention is bounded", async () => {
    const svc = new DetectionService(new SyntheticModel(), { maxRetained: 20 });
    await svc.initialize();
    const frame: Frame = { data: Buffer.alloc(16), width: 8, height: 8, timestamp: Date.now(), format: "RGB24" };
    for (let i = 0; i < 50; i++) svc.processFrame(frame, { sourceDroneId: "d1" });
    expect(svc.getDetections().length).toBeLessThanOrEqual(20);
  });

  test("stats expose inference cost to the operator", async () => {
    const svc = new DetectionService(new SyntheticModel());
    await svc.initialize();
    expect(svc.getStats()).toMatchObject({ loaded: true, provenance: "SYNTHETIC" });
    expect(svc.getStats().classes).toContain("person");
  });
});

describe("NMS and decoding", () => {
  test("overlapping boxes of the same object collapse to one", () => {
    const box = { x: 10, y: 10, width: 20, height: 20 };
    const out = nonMaxSuppression(
      [
        { class: "person", confidence: 0.9, boundingBox: box },
        { class: "person", confidence: 0.6, boundingBox: box },
      ],
      0.5,
    );
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(0.9);
  });

  test("distant boxes are both kept", () => {
    const out = nonMaxSuppression(
      [
        { class: "person", confidence: 0.9, boundingBox: { x: 0, y: 0, width: 10, height: 10 } },
        { class: "vehicle", confidence: 0.8, boundingBox: { x: 100, y: 100, width: 10, height: 10 } },
      ],
      0.5,
    );
    expect(out).toHaveLength(2);
  });

  test("IoU of identical boxes is 1 and disjoint boxes is 0", () => {
    const b = { x: 0, y: 0, width: 10, height: 10 };
    expect(iou(b, b)).toBeCloseTo(1);
    expect(iou(b, { x: 50, y: 50, width: 10, height: 10 })).toBe(0);
  });

  test("low confidence rows are discarded", () => {
    // One row: [cx,cy,w,h,obj, classScores...] with obj below threshold.
    const row = [32, 32, 10, 10, 0.1, 0.9, 0, 0, 0];
    expect(decodeFlatOutput(new Float32Array(row), ["person", "vehicle", "tree", "smoke", "fire"], 0.4)).toHaveLength(0);
  });

  test("a confident row decodes to the best class", () => {
    const row = [32, 32, 10, 10, 0.9, 0.1, 0.8];
    const out = decodeFlatOutput(new Float32Array(row), ["person", "vehicle"], 0.4);
    expect(out).toHaveLength(1);
    expect(out[0].class).toBe("vehicle");
  });
});

// ── Frame buffer ───────────────────────────────────────────────────────

describe("FrameBuffer", () => {
  const frame = (t: number) => ({ data: Buffer.alloc(4), width: 4, height: 4, timestamp: t, format: "RGB24" });

  test("drops the oldest frame when full", () => {
    const b = new FrameBuffer(2);
    b.push(frame(1));
    b.push(frame(2));
    b.push(frame(3));
    expect(b.size).toBe(2);
    expect(b.pop()?.timestamp).toBe(2);
  });

  test("popping an empty buffer returns null rather than throwing", () => {
    expect(new FrameBuffer(2).pop()).toBeNull();
  });
});

describe("simulator fault injection", () => {
  // The safety engine can only be trusted if every failure it claims to detect
  // can actually be provoked. These knobs are what make that possible.
  let sim: SimulatorDroneAdapter;

  beforeEach(() => {
    sim = new SimulatorDroneAdapter("sim-fault", {
      startLatitude: 37.7749,
      startLongitude: -122.4194,
      startAltitude: 50,
      speedMps: 5,
      batteryCapacityPercent: 100,
      drainRatePerSecond: 0, // hold battery steady unless a test changes it
      gpsNoiseMeters: 0,
      connectionLossChance: 0,
      windSpeedMps: 0,
      windDirectionDegrees: 0,
    });
  });

  afterEach(async () => {
    if (sim.isConnected()) await sim.disconnect();
  });

  test("RTH terminates on arrival at home", async () => {
    await sim.connect();
    await new Promise((r) => setTimeout(r, 200));
    const away = sim.getTelemetry()!.distanceFromHomeMeters;
    expect(away).toBeGreaterThan(0);

    await sim.requestRTH();
    // Give it time to fly home and settle.
    await new Promise((r) => setTimeout(r, 4000));

    const t = sim.getTelemetry()!;
    // Previously RTH never detected arrival: the aircraft flew over home
    // still climbing, forever. Termination is what makes the failsafe
    // verifiable.
    expect(t.distanceFromHomeMeters).toBeLessThan(20);
    expect(t.groundSpeed).toBe(0);
  });

  test("landing terminates at ground level rather than descending forever", async () => {
    // Start low so the descent completes inside a test. The behaviour under
    // test is termination at ground level, not the descent rate.
    const low = new SimulatorDroneAdapter("sim-land", {
      startLatitude: 37.7749,
      startLongitude: -122.4194,
      startAltitude: 3,
      groundElevation: 0,
      speedMps: 2,
      batteryCapacityPercent: 100,
      drainRatePerSecond: 0,
      gpsNoiseMeters: 0,
      connectionLossChance: 0,
      windSpeedMps: 0,
      windDirectionDegrees: 0,
    });
    try {
      await low.connect();
      await new Promise((r) => setTimeout(r, 150));
      expect(low.getTelemetry()!.altitude).toBeGreaterThan(0);

      await low.requestLand();
      // Descent is ~1.5 m/s, so a 3 m drop takes ~2 s.
      const deadline = Date.now() + 20_000;
      while (!low.hasLanded && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(low.hasLanded).toBe(true);
      const t = low.getTelemetry()!;
      expect(t.altitude).toBeGreaterThanOrEqual(-0.01);
      expect(t.verticalSpeed).toBe(0);
      expect(t.groundSpeed).toBe(0);
    } finally {
      if (low.isConnected()) await low.disconnect();
    }
  });

  test("a ground-speed wind can be provoked for the wind monitor", async () => {
    await sim.connect();
    await new Promise((r) => setTimeout(r, 150));
    sim.setSpeed(30); // comfortably above the 15 m/s wind threshold
    // Ground speed approaches the commanded value with a first-order lag, so
    // allow it time to settle.
    await new Promise((r) => setTimeout(r, 1500));
    expect(sim.getTelemetry()!.groundSpeed).toBeGreaterThan(15);
  });

  test("battery can be driven to the warning and critical thresholds", async () => {
    await sim.connect();
    await new Promise((r) => setTimeout(r, 150));
    sim.setBattery(15);
    await new Promise((r) => setTimeout(r, 200));
    expect(sim.getTelemetry()!.batteryPercentage).toBeLessThanOrEqual(15);

    sim.setBattery(3);
    await new Promise((r) => setTimeout(r, 200));
    expect(sim.getTelemetry()!.batteryPercentage).toBeLessThanOrEqual(5);
  });

  test("GPS degradation can be provoked", async () => {
    await sim.connect();
    await new Promise((r) => setTimeout(r, 150));
    sim.setGpsQuality(false, 2);
    await new Promise((r) => setTimeout(r, 200));
    const t = sim.getTelemetry()!;
    expect(t.gpsFix).toBe(false);
    expect(t.satelliteCount).toBe(2);
  });

  test("a link dropout can be provoked deterministically", async () => {
    await sim.connect();
    await new Promise((r) => setTimeout(r, 150));
    sim.dropLink();
    expect(sim.connectionState).toBe("LOST");
    sim.restoreLink();
    expect(sim.connectionState).toBe("CONNECTED");
  });

  test("a frozen telemetry clock can be provoked for the timeout monitor", async () => {
    // The timeout monitor keys off frame age, so the fault must be staleness,
    // not absence of frames.
    await sim.connect();
    await new Promise((r) => setTimeout(r, 150));
    sim.freezeTelemetryTimestamp();
    await new Promise((r) => setTimeout(r, 1200));
    const t = sim.getTelemetry()!;
    // Frames are still arriving; they are simply old. This is what a stalled
    // upstream would look like, and what the monitor must catch.
    expect(Date.now() - t.timestamp).toBeGreaterThan(1000);
  });
});

describe("SimulatorDroneAdapter", () => {
  let sim: SimulatorDroneAdapter;

  beforeEach(() => {
    sim = new SimulatorDroneAdapter("sim-1", {
      startLatitude: 37.7749,
      startLongitude: -122.4194,
      startAltitude: 50,
      speedMps: 5,
      batteryCapacityPercent: 100,
      // Drain fast enough to observe within a test.
      drainRatePerSecond: 1,
      gpsNoiseMeters: 2,
      connectionLossChance: 0,
      windSpeedMps: 3,
      windDirectionDegrees: 180,
    });
  });

  afterEach(async () => {
    if (sim.isConnected()) await sim.disconnect();
  });

  test("starts disconnected", () => {
    expect(sim.isConnected()).toBe(false);
  });

  test("produces telemetry once connected", async () => {
    await sim.connect();
    await new Promise((r) => setTimeout(r, 150));
    const t = sim.getTelemetry();
    expect(t).not.toBeNull();
    expect(t!.droneId).toBe("sim-1");
    expect(t!.gpsFix).toBe(true);
  });

  test("the aircraft actually moves along the ground track", async () => {
    await sim.connect();
    const start = { ...sim.getTelemetry()! };
    await new Promise((r) => setTimeout(r, 400));
    const later = sim.getTelemetry()!;
    const moved = Math.abs(later.latitude - start.latitude) + Math.abs(later.longitude - start.longitude);
    expect(moved).toBeGreaterThan(0);
  });

  test("battery is consumed during flight", async () => {
    await sim.connect();
    await new Promise((r) => setTimeout(r, 400));
    expect(sim.getTelemetry()!.batteryPercentage).toBeLessThan(100);
  });

  test("vertical speed stays bounded instead of drifting without limit", async () => {
    // The previous implementation added turbulence every tick without ever
    // damping it, so vspeed random-walked away and could never settle.
    await sim.connect();
    await new Promise((r) => setTimeout(r, 1500));
    expect(Math.abs(sim.getTelemetry()!.verticalSpeed)).toBeLessThan(5);
  });

  test("RTH steers the aircraft back toward home", async () => {
    await sim.connect();
    await new Promise((r) => setTimeout(r, 200));
    const away = sim.getTelemetry()!.distanceFromHomeMeters;
    await sim.requestRTH();
    await new Promise((r) => setTimeout(r, 600));
    // Must not continue flying away indefinitely.
    expect(sim.getTelemetry()!.distanceFromHomeMeters).toBeLessThanOrEqual(away + 50);
  });

  test("commands are rejected while disconnected", async () => {
    await expect(sim.requestRTH()).rejects.toThrow(/not connected/i);
  });

  test("pause stops position updates", async () => {
    await sim.connect();
    await new Promise((r) => setTimeout(r, 200));
    await sim.pauseMission();
    const held = sim.getTelemetry()!;
    await new Promise((r) => setTimeout(r, 300));
    const after = sim.getTelemetry()!;
    expect(after.latitude).toBeCloseTo(held.latitude, 6);
  });

  test("disconnect clears the link", async () => {
    await sim.connect();
    await sim.disconnect();
    expect(sim.isConnected()).toBe(false);
  });
});
