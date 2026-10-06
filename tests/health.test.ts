// RescueEye — system health aggregation tests.
//
// The rule these exist to protect: **UNKNOWN is not NOMINAL.** A subsystem that
// has not reported must never be folded into a healthy verdict, because an
// operator who is told "everything nominal" while half the system is unmeasured
// will stop looking.

import { SystemHealthManager } from "../backend/health_manager";

const NOW = 1_700_000_000_000;

describe("SystemHealthManager", () => {
  let mgr: SystemHealthManager;

  beforeEach(() => {
    mgr = new SystemHealthManager();
  });

  /** Everything healthy, so a single subsystem can be varied in isolation. */
  const allHealthy = {
    droneConnectionState: "CONNECTED",
    telemetryLatencyMs: 50,
    gpsFix: true,
    satelliteCount: 12,
    cameraActive: true,
    visionModelLoaded: true,
    batteryPercent: 90,
    missionStoreSize: 2,
    safetyEngineRunning: true,
    safetyEngineFaults: 0,
    persistenceDegraded: false,
    persistenceWriteFailures: 0,
    persistenceCorruptLines: 0,
    backendUptimeSeconds: 120,
  };

  function sub(snapshot: ReturnType<SystemHealthManager["evaluate"]>, id: string) {
    return snapshot.subsystems.find((x) => x.id === id)!;
  }

  test("a fully healthy system reports NOMINAL", () => {
    const snap = mgr.evaluate(allHealthy, NOW);
    expect(snap.overall).toBe("NOMINAL");
    expect(snap.unknownCount).toBe(0);
  });

  test("an unmeasured subsystem is UNKNOWN, never NOMINAL", () => {
    // Camera deliberately omitted.
    const { cameraActive, ...noCamera } = allHealthy;
    const snap = mgr.evaluate(noCamera, NOW);
    expect(sub(snap, "camera").status).toBe("UNKNOWN");
  });

  test("UNKNOWN propagates to the aggregate rather than being absorbed", () => {
    const { cameraActive, ...noCamera } = allHealthy;
    const snap = mgr.evaluate(noCamera, NOW);
    // Everything else is NOMINAL, but an unmeasured subsystem must not be
    // reported as a healthy system.
    expect(snap.overall).not.toBe("NOMINAL");
    expect(snap.overall).toBe("UNKNOWN");
    expect(snap.unknownCount).toBeGreaterThan(0);
  });

  test("an empty probe set is entirely UNKNOWN, not NOMINAL", () => {
    const snap = mgr.evaluate({}, NOW);
    expect(snap.overall).toBe("UNKNOWN");
    expect(snap.subsystems.every((x) => x.status === "UNKNOWN")).toBe(true);
  });

  test("no telemetry yet is UNKNOWN, not NOMINAL", () => {
    const snap = mgr.evaluate({ ...allHealthy, telemetryLatencyMs: null }, NOW);
    expect(sub(snap, "telemetry").status).toBe("UNKNOWN");
  });

  test("a disconnected link reports OFFLINE", () => {
    const snap = mgr.evaluate({ ...allHealthy, droneConnectionState: "DISCONNECTED" }, NOW);
    expect(sub(snap, "droneLink").status).toBe("OFFLINE");
    expect(snap.overall).toBe("OFFLINE");
  });

  test("a lost link reports CRITICAL", () => {
    const snap = mgr.evaluate({ ...allHealthy, droneConnectionState: "LOST" }, NOW);
    expect(sub(snap, "droneLink").status).toBe("CRITICAL");
  });

  test("high telemetry latency degrades, very high is critical", () => {
    expect(sub(mgr.evaluate({ ...allHealthy, telemetryLatencyMs: 1500 }, NOW), "telemetry").status).toBe("DEGRADED");
    expect(sub(mgr.evaluate({ ...allHealthy, telemetryLatencyMs: 5000 }, NOW), "telemetry").status).toBe("CRITICAL");
  });

  test("lost GPS fix is critical", () => {
    const snap = mgr.evaluate({ ...allHealthy, gpsFix: false, satelliteCount: 2 }, NOW);
    expect(sub(snap, "navigation").status).toBe("CRITICAL");
  });

  test("low battery degrades, critical battery is critical", () => {
    expect(sub(mgr.evaluate({ ...allHealthy, batteryPercent: 15 }, NOW), "battery").status).toBe("DEGRADED");
    expect(sub(mgr.evaluate({ ...allHealthy, batteryPercent: 3 }, NOW), "battery").status).toBe("CRITICAL");
  });

  test("a safety engine fault is CRITICAL", () => {
    // The most important line in this file: if the failsafe evaluator is
    // throwing, the aircraft is flying unmonitored and nothing else matters.
    const snap = mgr.evaluate({ ...allHealthy, safetyEngineFaults: 1 }, NOW);
    expect(sub(snap, "safetyEngine").status).toBe("CRITICAL");
    expect(snap.overall).toBe("CRITICAL");
  });

  test("a stopped safety engine is OFFLINE", () => {
    const snap = mgr.evaluate({ ...allHealthy, safetyEngineRunning: false }, NOW);
    expect(sub(snap, "safetyEngine").status).toBe("OFFLINE");
  });

  test("a persistence write failure is CRITICAL — the flight record is incomplete", () => {
    const snap = mgr.evaluate({ ...allHealthy, persistenceWriteFailures: 2 }, NOW);
    expect(sub(snap, "persistence").status).toBe("CRITICAL");
  });

  test("a degraded persistence layer is CRITICAL", () => {
    const snap = mgr.evaluate({ ...allHealthy, persistenceDegraded: true }, NOW);
    expect(sub(snap, "persistence").status).toBe("CRITICAL");
  });

  test("unreadable lines are DEGRADED, not CRITICAL", () => {
    // A skipped line is worth knowing about; lost writes are worse.
    const snap = mgr.evaluate({ ...allHealthy, persistenceCorruptLines: 3 }, NOW);
    expect(sub(snap, "persistence").status).toBe("DEGRADED");
  });

  test("an unloaded vision model is OFFLINE", () => {
    const snap = mgr.evaluate({ ...allHealthy, visionModelLoaded: false }, NOW);
    expect(sub(snap, "visionModel").status).toBe("OFFLINE");
  });

  test("worst status wins the aggregate", () => {
    // One degraded subsystem among nine nominal ones.
    const snap = mgr.evaluate({ ...allHealthy, batteryPercent: 15 }, NOW);
    expect(snap.overall).toBe("DEGRADED");
  });

  test("a time-boxed override changes the verdict and then lapses", () => {
    mgr.evaluate({ ...allHealthy, batteryPercent: 3 }, NOW);
    expect(mgr.evaluate(allHealthy, NOW).overall).toBe("NOMINAL");

    mgr.overrideSubsystem("battery", "NOMINAL", "pack swapped on the ground", 60_000, NOW);
    const suppressed = mgr.evaluate({ ...allHealthy, batteryPercent: 3 }, NOW + 1000);
    expect(sub(suppressed, "battery").status).toBe("NOMINAL");
    expect(suppressed.subsystems.find((x) => x.id === "battery")!.reason).toContain("override active");

    // After expiry the real verdict returns — a standing "ignore" switch is
    // exactly how a genuine fault gets missed.
    const afterExpiry = mgr.evaluate({ ...allHealthy, batteryPercent: 3 }, NOW + 61_000);
    expect(sub(afterExpiry, "battery").status).toBe("CRITICAL");
  });

  test("an override can be cleared early", () => {
    mgr.overrideSubsystem("battery", "NOMINAL", "temporary", 60_000, NOW);
    expect(mgr.clearOverride("battery")).toBe(true);
    expect(sub(mgr.evaluate({ ...allHealthy, batteryPercent: 3 }, NOW), "battery").status).toBe("CRITICAL");
  });

  test("every subsystem reports a reason an operator can read", () => {
    const snap = mgr.evaluate({}, NOW);
    for (const s of snap.subsystems) {
      expect(typeof s.reason).toBe("string");
      expect(s.reason.length).toBeGreaterThan(0);
      expect(s.observedAt).toBe(NOW);
    }
  });
});
