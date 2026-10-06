// RescueEye — Telemetry Service
// Aggregates telemetry from drone adapters and provides health monitoring.

import type { Telemetry, ConnectionState, Severity, Alert } from "../shared/models";

/** Minimum gap between two alerts of the same type. */
const ALERT_REPEAT_COOLDOWN_MS = 30_000;

export interface TelemetryListener {
  (telemetry: Telemetry): void;
}

export interface AlertListener {
  (alert: Alert): void;
}

export class TelemetryService {
  private telemetry: Telemetry | null = null;
  private listeners: TelemetryListener[] = [];
  private alertListeners: AlertListener[] = [];
  private alerts: Alert[] = [];
  private _lastAlertAt = new Map<string, number>();
  private _lastUpdateAt: number = 0;
  private _timeoutMs: number = 3000;
  private _healthCheckInterval: number | NodeJS.Timeout | null = null;

  constructor(timeoutMs: number = 3000) {
    this._timeoutMs = timeoutMs;
  }

  update(telemetry: Telemetry): void {
    this.telemetry = telemetry;
    this._lastUpdateAt = Date.now();
    this.listeners.forEach((cb) => cb(telemetry));
    this._checkAlerts(telemetry);
  }

  getTelemetry(): Telemetry | null {
    return this.telemetry;
  }

  getLatest(): Telemetry {
    if (!this.telemetry) {
      throw new Error("No telemetry data available");
    }
    return this.telemetry;
  }

  isConnected(): boolean {
    return (
      this.telemetry !== null &&
      this.telemetry.connectionState === "CONNECTED" &&
      Date.now() - this._lastUpdateAt < this._timeoutMs
    );
  }

  getConnectionState(): ConnectionState {
    if (!this.telemetry) return "DISCONNECTED";
    if (Date.now() - this._lastUpdateAt > this._timeoutMs) return "LOST";
    return this.telemetry.connectionState;
  }

  getAlerts(): Alert[] {
    return [...this.alerts];
  }

  clearAlerts(): void {
    this.alerts = [];
  }

  onTelemetry(cb: TelemetryListener): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  onAlert(cb: AlertListener): () => void {
    this.alertListeners.push(cb);
    return () => {
      this.alertListeners = this.alertListeners.filter((l) => l !== cb);
    };
  }

  startHealthMonitoring(intervalMs: number = 1000): void {
    if (this._healthCheckInterval !== null) return;
    this._healthCheckInterval = setInterval(() => {
      this._checkTimeout();
    }, intervalMs);
  }

  stopHealthMonitoring(): void {
    if (this._healthCheckInterval !== null) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
  }

  setTimeoutMs(ms: number): void {
    this._timeoutMs = ms;
  }

  // ── Private ──────────────────────────────────────────────────────

  private _checkAlerts(t: Telemetry): void {
    if (t.batteryPercentage < 20) {
      this._emitAlert({
        id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        droneId: t.droneId,
        type: "LOW_BATTERY",
        severity: t.batteryPercentage < 10 ? "CRITICAL" : "WARNING",
        message: `Battery low: ${t.batteryPercentage.toFixed(1)}%`,
        timestamp: Date.now(),
        acknowledged: false,
      });
    }

    if (t.batteryPercentage < 5) {
      this._emitAlert({
        id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        droneId: t.droneId,
        type: "CRITICAL_BATTERY",
        severity: "CRITICAL",
        message: `CRITICAL battery: ${t.batteryPercentage.toFixed(1)}% — return immediately`,
        timestamp: Date.now(),
        acknowledged: false,
      });
    }

    if (!t.gpsFix || t.satelliteCount < 4) {
      this._emitAlert({
        id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        droneId: t.droneId,
        type: "GPS_DEGRADED",
        severity: t.satelliteCount < 4 ? "CRITICAL" : "WARNING",
        message: `GPS degraded: fix=${t.gpsFix}, satellites=${t.satelliteCount}`,
        timestamp: Date.now(),
        acknowledged: false,
      });
    }

    if (t.connectionState === "LOST") {
      this._emitAlert({
        id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        droneId: t.droneId,
        type: "CONNECTION_LOST",
        severity: "CRITICAL",
        message: "Telemetry connection lost",
        timestamp: Date.now(),
        acknowledged: false,
      });
    }
  }

  private _checkTimeout(): void {
    if (
      this.telemetry &&
      Date.now() - this._lastUpdateAt > this._timeoutMs &&
      this.telemetry.connectionState !== "DISCONNECTED"
    ) {
      this.telemetry.connectionState = "LOST";
      this._emitAlert({
        id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        droneId: this.telemetry.droneId,
        type: "TELEMETRY_TIMEOUT",
        severity: "CRITICAL",
        message: "Telemetry timeout — no data received",
        timestamp: Date.now(),
        acknowledged: false,
      });
    }
  }

  private _emitAlert(alert: Alert): void {
    // Suppress repeats of a condition that is still true. Without this, a pack
    // sitting at 3% would emit an alert on every one of ~10 frames per second
    // and bury every other message the operator needs to read.
    const now = Date.now();
    const last = this._lastAlertAt.get(alert.type) ?? 0;
    if (now - last < ALERT_REPEAT_COOLDOWN_MS) {
      return;
    }
    this._lastAlertAt.set(alert.type, now);

    this.alerts.push(alert);
    // Keep only last 100 alerts
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100);
    }
    this.alertListeners.forEach((cb) => cb(alert));
  }
}
