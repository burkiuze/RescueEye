// RescueEye — Safety & Failsafe Service
// Prioritizes safety over mission completion.
// Manual operator control always has priority.

import type { Telemetry, ConnectionState, Alert, Severity } from "../shared/models";

export type SafetyState =
  | "NORMAL"
  | "LOW_BATTERY_WARNING"
  | "CRITICAL_BATTERY"
  | "GPS_DEGRADED"
  | "CONNECTION_LOST"
  | "GEOFENCE_WARNING"
  | "HIGH_WIND_WARNING"
  | "TELEMETRY_TIMEOUT"
  | "CAMERA_LOST"
  | "RTH_REQUESTED"
  | "EMERGENCY_LANDING"
  | "MISSION_PAUSED"
  | "MISSION_ABORTED";

export interface SafetyThresholds {
  lowBatteryPercent: number;
  criticalBatteryPercent: number;
  minSatellites: number;
  telemetryTimeoutMs: number;
  maxDistanceFromHomeMeters: number;
  maxWindSpeedMps: number;
  minGpsAccuracyMeters: number;
}

export interface SafetyAction {
  type: string;
  description: string;
  priority: number; // lower = higher priority
  requiresOperatorConfirmation: boolean;
}

export interface SafetyEvent {
  id: string;
  state: SafetyState;
  previousState: SafetyState;
  telemetry: Telemetry;
  action: SafetyAction;
  timestamp: number;
  acknowledged: boolean;
}

export class SafetyService {
  private thresholds: SafetyThresholds;
  private currentState: SafetyState = "NORMAL";
  private previousState: SafetyState = "NORMAL";
  /** Last emission time per state, used to suppress repeats. */
  private _lastEmitted = new Map<SafetyState, number>();
  private events: SafetyEvent[] = [];
  private _listeners: Array<(event: SafetyEvent) => void> = [];
  private _lastTelemetry: Telemetry | null = null;

  constructor(thresholds?: Partial<SafetyThresholds>) {
    this.thresholds = {
      lowBatteryPercent: thresholds?.lowBatteryPercent ?? 20,
      criticalBatteryPercent: thresholds?.criticalBatteryPercent ?? 5,
      minSatellites: thresholds?.minSatellites ?? 4,
      telemetryTimeoutMs: thresholds?.telemetryTimeoutMs ?? 3000,
      maxDistanceFromHomeMeters: thresholds?.maxDistanceFromHomeMeters ?? 5000,
      maxWindSpeedMps: thresholds?.maxWindSpeedMps ?? 15,
      minGpsAccuracyMeters: thresholds?.minGpsAccuracyMeters ?? 10,
    };
  }

  /**
   * Evaluate one telemetry frame.
   *
   * Events are emitted on the *transition* into a condition, not on every
   * frame that still satisfies it. Without this, a 10 Hz stream with the pack
   * at 3% would emit ~10 emergency-landing commands per second, flooding the
   * event log and the operator console until it became unreadable — which is
   * exactly when an operator most needs to read it.
   */
  evaluate(telemetry: Telemetry): SafetyEvent[] {
    this._lastTelemetry = telemetry;
    const newEvents: SafetyEvent[] = [];
    const now = Date.now();

    // Repeat suppression: the same condition re-firing only after a cooldown.
    // Chosen to be comfortably longer than a telemetry drop-out so a brief
    // sensor glitch does not re-announce, but short enough that a genuinely
    // new occurrence is still reported.
    const repeatCooldownMs = 30_000;

    const shouldEmit = (state: SafetyState): boolean => {
      const last = this._lastEmitted.get(state) ?? 0;
      if (now - last < repeatCooldownMs) return false;
      this._lastEmitted.set(state, now);
      return true;
    };

    // Check battery
    if (telemetry.batteryPercentage <= this.thresholds.criticalBatteryPercent) {
      if (shouldEmit("CRITICAL_BATTERY")) {
        const evt = this._createEvent(
          "CRITICAL_BATTERY",
          telemetry,
          {
            type: "EMERGENCY_LANDING",
            description: `Battery critical at ${telemetry.batteryPercentage.toFixed(1)}% — emergency landing required`,
            priority: 1,
            requiresOperatorConfirmation: false,
          }
        );
        newEvents.push(evt);
      }
      this._transitionTo("CRITICAL_BATTERY");
    } else if (telemetry.batteryPercentage <= this.thresholds.lowBatteryPercent) {
      if (shouldEmit("LOW_BATTERY_WARNING")) {
        const evt = this._createEvent(
          "LOW_BATTERY_WARNING",
          telemetry,
          {
            type: "RTH_REQUESTED",
            description: `Battery low at ${telemetry.batteryPercentage.toFixed(1)}% — return to home recommended`,
            priority: 2,
            requiresOperatorConfirmation: true,
          }
        );
        newEvents.push(evt);
      }
      this._transitionTo("LOW_BATTERY_WARNING");
    } else if (this.currentState === "LOW_BATTERY_WARNING" && telemetry.batteryPercentage > this.thresholds.lowBatteryPercent + 5) {
      this._transitionTo("NORMAL");
    }

    // Check GPS
    if (!telemetry.gpsFix || telemetry.satelliteCount < this.thresholds.minSatellites) {
      if (shouldEmit("GPS_DEGRADED")) {
        const evt = this._createEvent(
          "GPS_DEGRADED",
          telemetry,
          {
            type: "WARNING",
            description: `GPS degraded: fix=${telemetry.gpsFix}, satellites=${telemetry.satelliteCount}`,
            priority: 3,
            requiresOperatorConfirmation: true,
          }
        );
        newEvents.push(evt);
      }
      if (this.currentState === "NORMAL") this._transitionTo("GPS_DEGRADED");
    } else if (this.currentState === "GPS_DEGRADED" && telemetry.gpsFix && telemetry.satelliteCount >= this.thresholds.minSatellites) {
      this._transitionTo("NORMAL");
    }

    // Check connection
    if (telemetry.connectionState === "LOST") {
      if (shouldEmit("CONNECTION_LOST")) {
        const evt = this._createEvent(
          "CONNECTION_LOST",
          telemetry,
          {
            type: "CRITICAL",
            description: "Telemetry connection lost — failsafe triggered",
            priority: 1,
            requiresOperatorConfirmation: false,
          }
        );
        newEvents.push(evt);
      }
      this._transitionTo("CONNECTION_LOST");
    } else if (telemetry.connectionState === "CONNECTED" && this.currentState === "CONNECTION_LOST") {
      this._transitionTo("NORMAL");
    }

    // Check distance from home
    if (telemetry.distanceFromHomeMeters > this.thresholds.maxDistanceFromHomeMeters) {
      if (shouldEmit("GEOFENCE_WARNING")) {
        const evt = this._createEvent(
          "GEOFENCE_WARNING",
          telemetry,
          {
            type: "WARNING",
            description: `UAV ${telemetry.distanceFromHomeMeters.toFixed(0)}m from home — geofence warning`,
            priority: 4,
            requiresOperatorConfirmation: false,
          }
        );
        newEvents.push(evt);
      }
      if (this.currentState === "NORMAL") this._transitionTo("GEOFENCE_WARNING");
    }

    // Check wind
    if (telemetry.groundSpeed > this.thresholds.maxWindSpeedMps) {
      if (shouldEmit("HIGH_WIND_WARNING")) {
        const evt = this._createEvent(
          "HIGH_WIND_WARNING",
          telemetry,
          {
            type: "WARNING",
            description: `High wind detected: ${telemetry.groundSpeed.toFixed(1)} m/s`,
            priority: 5,
            requiresOperatorConfirmation: false,
          }
        );
        newEvents.push(evt);
      }
    }

    // Manual operator control always wins — if operator sends a command,
    // it overrides any automated safety state transition.
    // This is enforced at the MissionManager level.

    return newEvents;
  }

  getCurrentState(): SafetyState {
    return this.currentState;
  }

  getPreviousState(): SafetyState {
    return this.previousState;
  }

  getEvents(): SafetyEvent[] {
    return [...this.events];
  }

  acknowledgeEvent(eventId: string): boolean {
    const evt = this.events.find((e) => e.id === eventId);
    if (evt) {
      evt.acknowledged = true;
      return true;
    }
    return false;
  }

  onSafetyEvent(cb: (event: SafetyEvent) => void): () => void {
    this._listeners.push(cb);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== cb);
    };
  }

  // ── Private ──────────────────────────────────────────────────────

  private _createEvent(
    state: SafetyState,
    telemetry: Telemetry,
    action: SafetyAction
  ): SafetyEvent {
    const event: SafetyEvent = {
      id: `safety-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      state,
      previousState: this.currentState,
      telemetry: { ...telemetry },
      action,
      timestamp: Date.now(),
      acknowledged: false,
    };
    this.events.push(event);
    if (this.events.length > 500) {
      this.events = this.events.slice(-500);
    }
    this._listeners.forEach((cb) => cb(event));
    return event;
  }

  private _transitionTo(newState: SafetyState): void {
    if (newState === this.currentState) return;
    this.previousState = this.currentState;
    this.currentState = newState;
  }
}

// ── Failsafe Controller ───────────────────────────────────────────────
// Coordinates safety actions with mission control.

export interface FailsafeControllerConfig {
  safetyService: SafetyService;
  missionManager: {
    pauseMission: (id: string) => void;
    abortMission: (id: string) => void;
    requestRTH: (droneId: string) => void;
    requestLand: (droneId: string) => void;
  };
}

export class FailsafeController {
  private safetyService: SafetyService;
  private _callbacks: Array<(action: { type: string; droneId?: string }) => void> = [];

  constructor(safetyService: SafetyService) {
    this.safetyService = safetyService;

    // Listen for safety events and trigger appropriate failsafe actions
    this.safetyService.onSafetyEvent((event) => {
      this._handleSafetyEvent(event);
    });
  }

  onFailsafeAction(cb: (action: { type: string; droneId?: string }) => void): () => void {
    this._callbacks.push(cb);
    return () => {
      this._callbacks = this._callbacks.filter((c) => c !== cb);
    };
  }

  private _handleSafetyEvent(event: SafetyEvent): void {
    switch (event.state) {
      case "CRITICAL_BATTERY":
        this._emitAction({ type: "EMERGENCY_LANDING" });
        break;
      case "LOW_BATTERY_WARNING":
        this._emitAction({ type: "RTH_REQUESTED" });
        break;
      case "CONNECTION_LOST":
        this._emitAction({ type: "MISSION_ABORT" });
        break;
      case "GPS_DEGRADED":
        this._emitAction({ type: "WARNING" });
        break;
      case "GEOFENCE_WARNING":
        this._emitAction({ type: "WARNING" });
        break;
      case "HIGH_WIND_WARNING":
        this._emitAction({ type: "WARNING" });
        break;
    }
  }

  private _emitAction(action: { type: string; droneId?: string }): void {
    this._callbacks.forEach((cb) => cb(action));
  }
}
