// RescueEye — MAVLink Drone Adapter
// Implements DroneAdapter using MAVLink protocol for PX4 / ArduPilot.

import type {
  DroneAdapter,
  Telemetry,
  FlightMode,
  ConnectionState,
} from "../shared/models";
import type { MavlinkConfig, TelemetryParser, AutopilotProtocol } from "./adapter";

export class MavlinkDroneAdapter implements DroneAdapter {
  readonly droneId: string;
  private config: MavlinkConfig;
  private _connectionState: ConnectionState = "DISCONNECTED";
  private _telemetry: Telemetry | null = null;
  private _telemetryCallbacks: Array<(t: Telemetry) => void> = [];
  private _connectionCallbacks: Array<(s: ConnectionState) => void> = [];
  private _intervalIds: number[] = [];
  private _parser?: TelemetryParser;
  private _protocol?: AutopilotProtocol;

  constructor(droneId: string, config: MavlinkConfig) {
    this.droneId = droneId;
    this.config = config;
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  async connect(): Promise<void> {
    this._setState("CONNECTING");
    try {
      // In production this would open a UDP socket to the MAVLink stream
      // and start parsing MAVLink messages. For now we simulate the connection.
      await this._openMavlinkLink();
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
    // Send MAVLink SET_MODE message
    await this._sendMavlinkCommand("SET_MODE", { mode });
  }

  async requestRTH(): Promise<void> {
    if (!this.isConnected()) throw new Error("Drone not connected");
    await this._sendMavlinkCommand("RTL", {});
  }

  async requestLand(): Promise<void> {
    if (!this.isConnected()) throw new Error("Drone not connected");
    await this._sendMavlinkCommand("LAND", {});
  }

  async pauseMission(): Promise<void> {
    if (!this.isConnected()) throw new Error("Drone not connected");
    await this._sendMavlinkCommand("PAUSE", {});
  }

  async resumeMission(): Promise<void> {
    if (!this.isConnected()) throw new Error("Drone not connected");
    await this._sendMavlinkCommand("RESUME", {});
  }

  async abortMission(): Promise<void> {
    if (!this.isConnected()) throw new Error("Drone not connected");
    await this._sendMavlinkCommand("ABORT", {});
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

  // ── Private ──────────────────────────────────────────────────────────

  private _setState(state: ConnectionState): void {
    this._connectionState = state;
    this._connectionCallbacks.forEach((cb) => cb(state));
  }

  private async _openMavlinkLink(): Promise<void> {
    // Placeholder for real MAVLink UDP/TCP socket connection.
    // In production: new UdpSocket(config.udpPort) or TcpSocket(host, port).
    // The parser would be set to a MAVLink-specific parser implementation.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  private _startTelemetryPolling(): void {
    // In production this would read from the MAVLink socket and parse messages.
    // Here we simulate telemetry updates at ~10 Hz.
    const id = setInterval(() => {
      if (this._connectionState !== "CONNECTED") return;
      const t = this._generateSimulatedTelemetry();
      this._telemetry = t;
      this._telemetryCallbacks.forEach((cb) => cb(t));
    }, 100);
    this._intervalIds.push(id);
  }

  private _generateSimulatedTelemetry(): Telemetry {
    // Real adapter would parse actual MAVLink packets.
    // This fallback ensures the adapter never returns null when connected.
    return (
      this._telemetry ?? {
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
      }
    );
  }

  private async _sendMavlinkCommand(
    command: string,
    params: Record<string, unknown>
  ): Promise<void> {
    // In production: serialize and send MAVLink COMMAND_LONG or SET_MODE.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private _stopAll(): void {
    this._intervalIds.forEach((id) => clearInterval(id));
    this._intervalIds = [];
  }
}
