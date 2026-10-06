// RescueEye — Simulator Drone Adapter
// Provides realistic simulated telemetry that uses the exact same API as real adapters.

import type { DroneAdapter, Telemetry, FlightMode, ConnectionState } from "../shared/models";
import type { SimulatorConfig } from "../shared/models";

const DEFAULT_CONFIG: SimulatorConfig = {
  startLatitude: 37.7749,
  startLongitude: -122.4194,
  startAltitude: 50,
  speedMps: 5,
  headingDegrees: 90,
  batteryCapacityPercent: 100,
  drainRatePerSecond: 0.002,
  gpsNoiseMeters: 2,
  connectionLossChance: 0.001,
  windSpeedMps: 3,
  windDirectionDegrees: 180,
};

export class SimulatorDroneAdapter implements DroneAdapter {
  readonly droneId: string;
  private config: SimulatorConfig;
  private _connectionState: ConnectionState = "DISCONNECTED";
  private _telemetry: Telemetry | null = null;
  private _telemetryCallbacks: Array<(t: Telemetry) => void> = [];
  private _connectionCallbacks: Array<(s: ConnectionState) => void> = [];
  private _intervalIds: (number | NodeJS.Timeout)[] = [];
  private _simStartTime: number = 0;
  private _simElapsed: number = 0;
  private _currentLat: number;
  private _currentLon: number;
  private _currentAlt: number;
  private _currentHeading: number;
  private _currentBattery: number;
  private _currentSpeed: number;
  private _currentVSpeed: number;
  /** Commanded values; actual values settle toward these rather than drifting. */
  private _commandedSpeed: number;
  private _commandedVspeed: number = 0;
  private _flightDuration: number = 0;
  private _distanceFromHome: number = 0;
  private _waypointIndex: number = 0;
  private _waypoints: Array<{ lat: number; lon: number; alt: number }> = [];
  private _isPaused: boolean = false;
  private _isAborted: boolean = false;
  private _flightMode: FlightMode = "AUTO";

  constructor(droneId: string, config?: Partial<SimulatorConfig>) {
    this.droneId = droneId;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._currentLat = this.config.startLatitude;
    this._currentLon = this.config.startLongitude;
    this._currentAlt = this.config.startAltitude;
    this._currentHeading = this.config.headingDegrees;
    this._currentBattery = this.config.batteryCapacityPercent;
    this._currentSpeed = this.config.speedMps;
    this._commandedSpeed = this.config.speedMps;
    this._currentVSpeed = 0;
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  async connect(): Promise<void> {
    this._setState("CONNECTING");
    await new Promise((resolve) => setTimeout(resolve, 100));
    this._setState("CONNECTED");
    this._simStartTime = Date.now();
    // Publish a frame immediately so a client that connects right away has
    // position data before the first 100 ms tick lands.
    const initial = this._buildTelemetry();
    this._telemetry = initial;
    this._startSimulation();
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
    if (!this.isConnected()) throw new Error("Simulator not connected");
    this._flightMode = mode;
  }

  async requestRTH(): Promise<void> {
    if (!this.isConnected()) throw new Error("Simulator not connected");
    // Steer back toward home instead of merely flagging an intent.
    this._waypoints = [];
    this._waypointIndex = 0;
    this._commandedSpeed = Math.max(this.config.speedMps, 5);
    const toHome = this._bearingTo(
      this.config.startLatitude,
      this.config.startLongitude,
    );
    this._currentHeading = toHome;
    this._commandedVspeed = 1.5; // gentle climb while returning
    this._flightMode = "RTL";
  }

  async requestLand(): Promise<void> {
    if (!this.isConnected()) throw new Error("Simulator not connected");
    this._waypoints = [];
    this._waypointIndex = 0;
    this._commandedVspeed = -1.5; // descend
    this._flightMode = "LAND";
  }

  async pauseMission(): Promise<void> {
    this._isPaused = true;
  }

  async resumeMission(): Promise<void> {
    this._isPaused = false;
  }

  async abortMission(): Promise<void> {
    this._isAborted = true;
    this._waypoints = [];
    this._waypointIndex = 0;
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

  // ── Simulator-specific controls ──────────────────────────────────────

  setWaypoints(waypoints: Array<{ lat: number; lon: number; alt: number }>): void {
    this._waypoints = waypoints;
    this._waypointIndex = 0;
  }

  setSpeed(mps: number): void {
    this._commandedSpeed = mps;
  }

  setWind(speedMps: number, directionDegrees: number): void {
    this.config.windSpeedMps = speedMps;
    this.config.windDirectionDegrees = directionDegrees;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private _setState(state: ConnectionState): void {
    this._connectionState = state;
    this._connectionCallbacks.forEach((cb) => cb(state));
  }

  private _startSimulation(): void {
    // Telemetry update at ~10 Hz
    const telemetryId = setInterval(() => {
      if (this._connectionState !== "CONNECTED") return;
      if (this._isPaused) return;
      this._tickSimulation();
      const t = this._buildTelemetry();
      this._telemetry = t;
      this._telemetryCallbacks.forEach((cb) => cb(t));
    }, 100);
    this._intervalIds.push(telemetryId);

    // Simulate occasional connection issues
    const connectionId = setInterval(() => {
      if (this._connectionState !== "CONNECTED") return;
      if (Math.random() < this.config.connectionLossChance) {
        this._setState("LOST");
        setTimeout(() => {
          if (this._connectionState === "LOST") {
            this._setState("CONNECTED");
          }
        }, 2000);
      }
    }, 5000);
    this._intervalIds.push(connectionId);
  }

  private _tickSimulation(): void {
    const dt = 0.1; // 100ms step
    this._simElapsed += dt;
    this._flightDuration = this._simElapsed;

    // Move toward next waypoint or continue in current heading
    if (this._waypoints.length > 0 && this._waypointIndex < this._waypoints.length) {
      const wp = this._waypoints[this._waypointIndex];
      const dLat = wp.lat - this._currentLat;
      const dLon = wp.lon - this._currentLon;
      const dAlt = wp.alt - this._currentAlt;
      const dist = Math.sqrt(dLat * dLat + dLon * dLon + dAlt * dAlt);

      if (dist < 0.0001) {
        // Reached waypoint
        this._waypointIndex++;
        return;
      }

      const step = this._currentSpeed * dt;
      const ratio = Math.min(step / dist, 1);
      this._currentLat += dLat * ratio;
      this._currentLon += dLon * ratio;
      this._currentAlt += dAlt * ratio;

      // Update heading toward waypoint
      const targetHeading = (Math.atan2(dLon, dLat) * 180) / Math.PI;
      this._currentHeading = this._normalizeAngle(targetHeading);
    } else {
      // Continue in current heading
      const rad = (this._currentHeading * Math.PI) / 180;
      const moveLat = (this._currentSpeed * dt * Math.cos(rad)) / 111320;
      const moveLon = (this._currentSpeed * dt * Math.sin(rad)) / (111320 * Math.cos((this._currentLat * Math.PI) / 180));
      this._currentLat += moveLat;
      this._currentLon += moveLon;
    }

    // Add GPS noise
    this._currentLat += (Math.random() - 0.5) * this.config.gpsNoiseMeters / 111320;
    this._currentLon += (Math.random() - 0.5) * this.config.gpsNoiseMeters / (111320 * Math.cos((this._currentLat * Math.PI) / 180));

    // Battery drain
    // drainRatePerSecond is percentage points per second, so a full pack with
// the default 0.083 lasts ~1200s (20 min) of flight.
    this._currentBattery = Math.max(
      0,
      this._currentBattery - this.config.drainRatePerSecond * dt,
    );

    // Wind: push the aircraft along the wind vector rather than the random-walk
    // the previous implementation used (which drifted without ever damping, so
    // vertical speed diverged instead of settling).
    const windRad = (this.config.windDirectionDegrees * Math.PI) / 180;
    const windPushMps = this.config.windSpeedMps * 0.15;
    const groundDriftLat = (windPushMps * dt * Math.cos(windRad)) / 111320;
    const groundDriftLon = (windPushMps * dt * Math.sin(windRad)) / (111320 * Math.cos((this._currentLat * Math.PI) / 180));
    this._currentLat += groundDriftLat;
    this._currentLon += groundDriftLon;

    // Turbulence decays back to a commanded vertical speed instead of
    // accumulating without bound.
    this._commandedVspeed = this._commandedVspeed ?? 0;
    this._currentVSpeed += (this._commandedVspeed - this._currentVSpeed) * 0.1;
    this._currentVSpeed += (Math.random() - 0.5) * 0.05;

    // Speed also settles toward the commanded value rather than drifting.
    this._currentSpeed += (this._commandedSpeed - this._currentSpeed) * 0.1;
    this._currentSpeed = Math.max(0, this._currentSpeed);

    // Distance from home (metres), accounting for longitude convergence.
    const dLat = (this._currentLat - this.config.startLatitude) * 111320;
    const dLon = (this._currentLon - this.config.startLongitude) * 111320 * Math.cos((this._currentLat * Math.PI) / 180);
    this._distanceFromHome = Math.sqrt(dLat * dLat + dLon * dLon);
  }

  private _buildTelemetry(): Telemetry {
    return {
      droneId: this.droneId,
      latitude: this._currentLat,
      longitude: this._currentLon,
      altitude: this._currentAlt,
      relativeAltitude: this._currentAlt - this.config.startAltitude,
      heading: this._currentHeading,
      groundSpeed: this._currentSpeed,
      verticalSpeed: this._currentVSpeed,
      pitch: (Math.random() - 0.5) * 5,
      roll: (Math.random() - 0.5) * 5,
      yaw: this._currentHeading,
      batteryPercentage: this._currentBattery,
      voltage: 12.6 * (this._currentBattery / 100),
      gpsFix: this._connectionState === "CONNECTED",
      satelliteCount: 8 + Math.floor(Math.random() * 8),
      flightMode: this._flightMode,
      connectionState: this._connectionState,
      homeLatitude: this.config.startLatitude,
      homeLongitude: this.config.startLongitude,
      homeAltitude: this.config.startAltitude,
      flightDurationSeconds: this._flightDuration,
      distanceFromHomeMeters: this._distanceFromHome,
      timestamp: Date.now(),
    };
  }

  private _normalizeAngle(deg: number): number {
    return ((deg % 360) + 360) % 360;
  }

  /** Compass bearing from the current position to a target. */
  private _bearingTo(lat: number, lon: number): number {
    const dLat = lat - this._currentLat;
    const dLon = (lon - this._currentLon) * Math.cos((this._currentLat * Math.PI) / 180);
    return this._normalizeAngle((Math.atan2(dLon, dLat) * 180) / Math.PI);
  }

  private _stopAll(): void {
    this._intervalIds.forEach((id) => {
      if (typeof id === "number") {
        clearInterval(id);
      } else {
        clearInterval(id as unknown as number);
      }
    });
    this._intervalIds = [];
  }
}
