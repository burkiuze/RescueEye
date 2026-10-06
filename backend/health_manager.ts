// RescueEye — System health manager.
//
// Aggregates the health of every subsystem into a single verdict so an operator
// can answer "can I trust this console right now?" without reading ten panels.
//
// The rule that shapes this file: **UNKNOWN is not NOMINAL.** A subsystem that
// has not reported cannot be treated as healthy. If the camera has never been
// seen, the honest verdict is UNKNOWN, and an aggregate that reports NOMINAL
// while half its inputs are missing is worse than no health at all — it is
// false reassurance during a search.
//
// Severity ordering, worst wins:
//
//   OFFLINE > CRITICAL > DEGRADED > UNKNOWN > NOMINAL
//
// UNKNOWN sits below DEGRADED deliberately: a subsystem we cannot measure is a
// problem to resolve, but a subsystem we measured and found impaired is more
// urgent.

export type HealthStatus = "NOMINAL" | "UNKNOWN" | "DEGRADED" | "CRITICAL" | "OFFLINE";

const SEVERITY: Record<HealthStatus, number> = {
  NOMINAL: 0,
  UNKNOWN: 1,
  DEGRADED: 2,
  CRITICAL: 3,
  OFFLINE: 4,
};

export type SubsystemId =
  | "droneLink"
  | "telemetry"
  | "navigation"
  | "camera"
  | "visionModel"
  | "battery"
  | "mission"
  | "safetyEngine"
  | "persistence"
  | "backend";

export interface SubsystemHealth {
  id: SubsystemId;
  status: HealthStatus;
  /** Why this status. Shown verbatim in the console. */
  reason: string;
  /** Unix ms of the last observation. */
  observedAt: number;
}

export interface HealthSnapshot {
  overall: HealthStatus;
  subsystems: SubsystemHealth[];
  /** Subsystems that could not be measured. Never folded into NOMINAL. */
  unknownCount: number;
  criticalCount: number;
  evaluatedAt: number;
}

/** Per-subsystem probes, injected so this stays testable without the server. */
export interface HealthProbes {
  droneConnectionState?: string;
  telemetryLatencyMs?: number | null;
  gpsFix?: boolean;
  satelliteCount?: number;
  cameraActive?: boolean;
  cameraConfigured?: boolean;
  visionModelLoaded?: boolean;
  batteryPercent?: number;
  missionStoreSize?: number;
  safetyEngineFaults?: number;
  safetyEngineRunning?: boolean;
  persistenceDegraded?: boolean;
  persistenceWriteFailures?: number;
  persistenceCorruptLines?: number;
  backendUptimeSeconds?: number;
}

export class SystemHealthManager {
  private overrides = new Map<SubsystemId, { status: HealthStatus; reason: string; until: number }>();

  /**
   * Evaluate every subsystem and fold into one verdict.
   *
   * A subsystem with no probe data is UNKNOWN, never NOMINAL. That is the whole
   * point of this method.
   */
  evaluate(p: HealthProbes, now = Date.now()): HealthSnapshot {
    const subsystems: SubsystemHealth[] = [
      this._droneLink(p, now),
      this._telemetry(p, now),
      this._navigation(p, now),
      this._camera(p, now),
      this._visionModel(p, now),
      this._battery(p, now),
      this._mission(p, now),
      this._safetyEngine(p, now),
      this._persistence(p, now),
      this._backend(p, now),
    ].map((s) => this._applyOverride(s, now));

    const overall = subsystems.reduce<HealthStatus>(
      (worst, s) => (SEVERITY[s.status] > SEVERITY[worst] ? s.status : worst),
      "NOMINAL",
    );

    return {
      overall,
      subsystems,
      unknownCount: subsystems.filter((s) => s.status === "UNKNOWN").length,
      criticalCount: subsystems.filter((s) => s.status === "CRITICAL" || s.status === "OFFLINE")
        .length,
      evaluatedAt: now,
    };
  }

  // ── Individual probes ────────────────────────────────────────────────

  private _droneLink(p: HealthProbes, now: number): SubsystemHealth {
    if (p.droneConnectionState === undefined) {
      return u("droneLink", "no connection state reported", now);
    }
    if (p.droneConnectionState === "DISCONNECTED") {
      return s("droneLink", "OFFLINE", `link state ${p.droneConnectionState}`, now);
    }
    if (p.droneConnectionState === "LOST") {
      return s("droneLink", "CRITICAL", "telemetry link lost", now);
    }
    if (p.droneConnectionState === "CONNECTING") {
      return s("droneLink", "DEGRADED", "link establishing", now);
    }
    return s("droneLink", "NOMINAL", `link ${p.droneConnectionState}`, now);
  }

  private _telemetry(p: HealthProbes, now: number): SubsystemHealth {
    if (p.telemetryLatencyMs === undefined || p.telemetryLatencyMs === null) {
      return u("telemetry", "no telemetry frame received", now);
    }
    if (p.telemetryLatencyMs < 0) {
      return u("telemetry", "telemetry not yet received", now);
    }
    if (p.telemetryLatencyMs > 3000) return s("telemetry", "CRITICAL", `latency ${p.telemetryLatencyMs}ms`, now);
    if (p.telemetryLatencyMs > 1000) return s("telemetry", "DEGRADED", `latency ${p.telemetryLatencyMs}ms`, now);
    return s("telemetry", "NOMINAL", `latency ${p.telemetryLatencyMs}ms`, now);
  }

  private _navigation(p: HealthProbes, now: number): SubsystemHealth {
    if (p.gpsFix === undefined && p.satelliteCount === undefined) {
      return u("navigation", "navigation not reported by adapter", now);
    }
    if (p.gpsFix === false) return s("navigation", "CRITICAL", "no GPS fix", now);
    const sats = p.satelliteCount ?? 0;
    if (sats < 4) return s("navigation", "CRITICAL", `${sats} satellites`, now);
    if (sats < 6) return s("navigation", "DEGRADED", `${sats} satellites`, now);
    return s("navigation", "NOMINAL", `${sats} satellites, fix ok`, now);
  }

  private _camera(p: HealthProbes, now: number): SubsystemHealth {
    // Explicitly UNKNOWN until a camera source is wired in. The camera sources
    // in vision/ report fps and a resolution while nothing is connected, so
    // trusting their stats would report a healthy camera that does not exist.
    if (p.cameraActive === undefined) {
      return u("camera", "no camera source wired to the server", now);
    }
    if (!p.cameraActive) return s("camera", "OFFLINE", "camera not streaming", now);
    return s("camera", "NOMINAL", "camera streaming", now);
  }

  private _visionModel(p: HealthProbes, now: number): SubsystemHealth {
    if (p.visionModelLoaded === undefined) {
      return u("visionModel", "no vision model loaded", now);
    }
    return p.visionModelLoaded
      ? s("visionModel", "NOMINAL", "model loaded", now)
      : s("visionModel", "OFFLINE", "model not loaded", now);
  }

  private _battery(p: HealthProbes, now: number): SubsystemHealth {
    if (p.batteryPercent === undefined) {
      return u("battery", "no battery telemetry", now);
    }
    if (p.batteryPercent <= 5) return s("battery", "CRITICAL", `${p.batteryPercent.toFixed(1)}%`, now);
    if (p.batteryPercent <= 20) return s("battery", "DEGRADED", `${p.batteryPercent.toFixed(1)}%`, now);
    return s("battery", "NOMINAL", `${p.batteryPercent.toFixed(1)}%`, now);
  }

  private _mission(p: HealthProbes, now: number): SubsystemHealth {
    if (p.missionStoreSize === undefined) {
      return u("mission", "mission store not reachable", now);
    }
    return s("mission", "NOMINAL", `${p.missionStoreSize} mission(s) on record`, now);
  }

  private _safetyEngine(p: HealthProbes, now: number): SubsystemHealth {
    if (p.safetyEngineRunning === undefined) {
      return u("safetyEngine", "safety engine state unknown", now);
    }
    if (!p.safetyEngineRunning) {
      return s("safetyEngine", "OFFLINE", "safety engine not running", now);
    }
    // A fault here is the worst thing this system can report: the failsafe is
    // not being evaluated and nobody would know.
    if ((p.safetyEngineFaults ?? 0) > 0) {
      return s("safetyEngine", "CRITICAL", `${p.safetyEngineFaults} evaluation fault(s)`, now);
    }
    return s("safetyEngine", "NOMINAL", "evaluating every frame", now);
  }

  private _persistence(p: HealthProbes, now: number): SubsystemHealth {
    if (p.persistenceDegraded === undefined) {
      return u("persistence", "persistence state unknown", now);
    }
    if (p.persistenceWriteFailures !== undefined && p.persistenceWriteFailures > 0) {
      return s("persistence", "CRITICAL", `${p.persistenceWriteFailures} write failure(s) — flight record incomplete`, now);
    }
    if (p.persistenceDegraded) {
      return s("persistence", "CRITICAL", "store degraded to in-memory; records are not durable", now);
    }
    if ((p.persistenceCorruptLines ?? 0) > 0) {
      return s("persistence", "DEGRADED", `${p.persistenceCorruptLines} unreadable line(s) skipped`, now);
    }
    return s("persistence", "NOMINAL", "append-only store healthy", now);
  }

  private _backend(p: HealthProbes, now: number): SubsystemHealth {
    if (p.backendUptimeSeconds === undefined) {
      return u("backend", "backend not reporting", now);
    }
    return s("backend", "NOMINAL", `up ${Math.round(p.backendUptimeSeconds)}s`, now);
  }

  private _applyOverride(s: SubsystemHealth, now: number): SubsystemHealth {
    const o = this.overrides.get(s.id);
    if (!o) return s;
    if (now >= o.until) {
      this.overrides.delete(s.id);
      return s;
    }
    return { ...s, status: o.status, reason: `${o.reason} (override active)` };
  }

  /**
   * Time-box a health override. Same reasoning as the failsafe override: a
   * standing "ignore this" switch is how a real fault gets missed.
   */
  overrideSubsystem(
    id: SubsystemId,
    status: HealthStatus,
    reason: string,
    durationMs = 120_000,
    now = Date.now(),
  ): void {
    this.overrides.set(id, { status, reason, until: now + durationMs });
  }

  clearOverride(id: SubsystemId): boolean {
    return this.overrides.delete(id);
  }
}

function s(id: SubsystemId, status: HealthStatus, reason: string, now: number): SubsystemHealth {
  return { id, status, reason, observedAt: now };
}

function u(id: SubsystemId, reason: string, now: number): SubsystemHealth {
  return { id, status: "UNKNOWN", reason, observedAt: now };
}
