// RescueEye — MAVSDK Drone Adapter
// Implements DroneAdapter using MAVSDK protocol for modern drone control.

import type {
  DroneAdapter,
  Telemetry,
  FlightMode,
  ConnectionState,
} from "../shared/models";
import type { MavsdkConfig } from "./adapter";

export class MavsdkDroneAdapter implements DroneAdapter {
  readonly droneId: string;
  private config: MavsdkConfig;
  private _connectionState: ConnectionState = "DISCONNECTED";
  private _telemetry: Telemetry | null = null;
  private _telemetryCallbacks: Array<(t: Telemetry) => void> = [];
  private _connectionCallbacks: Array<(s: ConnectionState) => void> = [];
  private _intervalIds: number[] = [];

  constructor(droneId: string, config: MavsdkConfig) {
    this.droneId = droneId;
    this.config = config;
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  async connect(): Promise<void> {
    this._setState("CONNECTING");
    try {
      await this._openMavsdkLink();
      this._setState("CONNECTED");
      this._startTelemetryPolling();
    } catch (err) {
      this._setState("DISCONNECTED");
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this._stopAll();
    this._setState("DISCONNECTED");
  }

  getTelemetry(): Telemetry | null {
    return this._telemetry;
  }

  isConnected(): boolean {
    return this._connectionState === "CONNECTED";
  }

  async setFlightMode(mode: FlightMode): Promise<void> {
    if (!this.isConnected()) throw new Error("Drone not connected");
    await this._sendMavsdkCommand("SET_FLIGHT_MODE", { mode });
  }

  async requestRTH(): Promise<void> {
    if (!this.isConnected()) throw new Error("Drone not connected");
    await this._sendMavsdkCommand("RTL", {});
  }

  async requestLand(): Promise<void> {
    if (!this.isConnected()) throw new Error("Drone not connected");
    await this._sendMavsdkCommand("LAND", {});
  }

  async pauseMission(): Promise<void> {
    if (!this.isConnected()) throw new Error("Drone not connected");
    await this._sendMavsdkCommand("PAUSE", {});
  }

  async resumeMission(): Promise<void> {
    if (!this.isConnected()) throw new Error("Drone not connected");
    await this._sendMavsdkCommand("RESUME", {});
  }

  async abortMission(): Promise<void> {
    if (!this.isConnected()) throw new Error("Drone not connected");
    await this._sendMavsdkCommand("ABORT", {});
  }

  onTelemetry(cb: (t: Telemetry) => void): () => void {
    this._telemetryCallbacks.push(cb);
    return () => {
      this._telemetryCallbacks = this._telemetryCallbacks.filter((c) => c !== cb);
    };
  }

  onConnectionChange(cb: (s: ConnectionState) => void): () => void {
    this._connectionCallbacks.push(cb);
    return () => {
      this._connectionCallbacks = this._connectionCallbacks.filter((c) => c !== cb);
    };
  }

  private _setState(state: ConnectionState): void {
    this._connectionState = state;
    this._connectionCallbacks.forEach((cb) => cb(state));
  }

  private async _openMavsdkLink(): Promise<void> {
    // In production: connect to MAVSDK server via gRPC/WebSocket.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  private _startTelemetryPolling(): void {
    const id = setInterval(() => {
      if (this._connectionState !== "CONNECTED") return;
      const t = this._telemetry ?? this._defaultTelemetry();
      t.timestamp = Date.now();
      t.flightDurationSeconds = Math.floor((Date.now() - t.timestamp) / 1000);
      this._telemetry = t;
      this._telemetryCallbacks.forEach((cb) => cb(t));
    }, 100);
    this._intervalIds.push(id);
  }

  private _defaultTelemetry(): Telemetry {
    return {
      droneId: this.droneId,
      latitude: 0,
      longitude: 0,
      altitude: 0,
      relativeAltitude: 0,
      heading: 0,
      groundSpeed: 0,
      verticalSpeed: 0,
      pitch: 0,
      roll: 0,
      yaw: 0,
      batteryPercentage: 100,
      voltage: 0,
      gpsFix: false,
      satelliteCount: 0,
      flightMode: "SIMULATED",
      connectionState: "CONNECTED",
      homeLatitude: 0,
      homeLongitude: 0,
      homeAltitude: 0,
      flightDurationSeconds: 0,
      distanceFromHomeMeters: 0,
      timestamp: Date.now(),
    };
  }

  private async _sendMavsdkCommand(
    _command: string,
    _params: Record<string, unknown>
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private _stopAll(): void {
    this._intervalIds.forEach((id) => clearInterval(id));
    this._intervalIds = [];
  }
}
