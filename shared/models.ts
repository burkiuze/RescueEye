// RescueEye — Shared Data Models
// These types are used by both backend and frontend.
// Keep them plain TypeScript objects with no framework dependencies.

export type MissionStatus =
  | "PLANNED"
  | "READY"
  | "ACTIVE"
  | "PAUSED"
  | "COMPLETED"
  | "ABORTED"
  | "FAILED";

// ── Operators, roles and audit ─────────────────────────────────────────

/**
 * Capabilities are granted per role. Authorisation is checked against these,
 * never against the raw role name, so that adding a role cannot accidentally
 * widen someone's permissions.
 *
 * "observer"    may watch. Cannot command the aircraft.
 * "operator"    may plan and run search missions, start/pause/abort.
 * "safetyOfficer" may additionally override an automated failsafe and issue
 *                RTH / emergency land. Kept separate from "operator" on
 *                purpose: it is the human who carries responsibility for
 *                telling an automated system to stand down.
 * "admin"       may manage accounts and configuration only.
 */
export type Role = "observer" | "operator" | "safetyOfficer" | "admin";

export type Capability =
  | "mission:read"
  | "mission:write"
  | "mission:control"
  | "drone:command"
  | "failsafe:override"
  | "config:write"
  | "account:manage";

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  observer: ["mission:read"],
  operator: ["mission:read", "mission:write", "mission:control"],
  safetyOfficer: [
    "mission:read",
    "mission:write",
    "mission:control",
    "drone:command",
    "failsafe:override",
  ],
  admin: ["config:write", "account:manage"],
};

export function roleHasCapability(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

export interface Operator {
  id: string;
  username: string;
  role: Role;
  createdAt: number;
  disabled?: boolean;
}

/**
 * Append-only audit record for anything that affects the aircraft.
 *
 * Written for every commanded change (mission start/abort, RTH, land, failsafe
 * override) so that after an incident it is possible to answer "who told the
 * aircraft to do that, and were they allowed to?". Entries are never updated
 * or deleted.
 */
export interface AuditEntry {
  id: string;
  at: number;
  actorId: string;
  actorUsername: string;
  actorRole: Role;
  action: string;
  target: string;
  outcome: "allowed" | "denied" | "applied" | "failed";
  detail?: Record<string, unknown>;
}

/** Result of an arbitration between an automated failsafe and a human override. */
export interface OverrideRecord {
  id: string;
  at: number;
  operatorId: string;
  operatorUsername: string;
  safetyState: string;
  overriddenAction: string;
  reason: string;
  /** How long the override remains in force. */
  expiresAt: number;
}

export type FlightMode =
  | "STABILIZE"
  | "AUTO"
  | "GUIDED"
  | "LOITER"
  | "RTL"
  | "LAND"
  | "MISSION"
  | "SIMULATED";

export type ConnectionState = "CONNECTED" | "DISCONNECTED" | "CONNECTING" | "LOST";

export type Severity = "INFO" | "WARNING" | "CRITICAL" | "ERROR";

export type EventType =
  | "MISSION_START"
  | "MISSION_PAUSE"
  | "MISSION_RESUME"
  | "MISSION_ABORT"
  | "MISSION_COMPLETE"
  | "DRONE_CONNECTED"
  | "DRONE_DISCONNECTED"
  | "WAYPOINT_REACHED"
  | "DETECTION"
  | "WARNING"
  | "ALERT"
  | "TELEMETRY_TIMEOUT"
  | "CONNECTION_LOST"
  | "GPS_DEGRADED"
  | "LOW_BATTERY"
  | "CRITICAL_BATTERY"
  | "GEOFENCE_WARNING"
  | "CAMERA_LOST"
  | "HIGH_WIND"
  | "EMERGENCY_LANDING"
  | "RTH_TRIGGERED"
  | "SIMULATION_STEP";

// ── Telemetry ──────────────────────────────────────────────────────────

export interface Telemetry {
  droneId: string;
  latitude: number;
  longitude: number;
  altitude: number;           // absolute altitude (m)
  relativeAltitude: number;   // above home (m)
  heading: number;            // 0-360 degrees
  groundSpeed: number;        // m/s
  verticalSpeed: number;      // m/s (positive = climbing)
  pitch: number;              // degrees
  roll: number;               // degrees
  yaw: number;                // degrees
  batteryPercentage: number;  // 0-100
  voltage: number;            // volts
  gpsFix: boolean;
  satelliteCount: number;
  flightMode: FlightMode;
  connectionState: ConnectionState;
  homeLatitude: number;
  homeLongitude: number;
  homeAltitude: number;
  flightDurationSeconds: number;
  distanceFromHomeMeters: number;
  timestamp: number;          // Unix ms
}

// ── Detection ──────────────────────────────────────────────────────────

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DetectionProvenance = "MODEL" | "SYNTHETIC" | "OPERATOR";

export interface Detection {
  id: string;
  class: string;            // "person" | "vehicle" | "building" | "debris" | …
  confidence: number;       // 0-1
  boundingBox: BoundingBox;
  timestamp: number;        // Unix ms
  frameId: string;
  sourceDroneId: string;
  /**
   * Where this detection came from.
   *
   * "SYNTHETIC" detections are generated by the simulator/demostration path and
   * MUST NOT be presented to an operator as a real finding. A human rescuer
   * acting on a fabricated detection can send a team into an unsafe area or,
   * worse, call off a search for a person who is still there.
   *
   * "MODEL"  = produced by a loaded inference model on real imagery.
   * "SYNTHETIC" = produced by the demo/simulator generator. Not actionable.
   * "OPERATOR" = manually marked by a human operator (e.g. a ground team report).
   */
  provenance: DetectionProvenance;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  metadata?: Record<string, unknown>;
}

// ── Drone Adapter ──────────────────────────────────────────────────────

export interface DroneAdapter {
  readonly droneId: string;
  readonly connectionState: ConnectionState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getTelemetry(): Telemetry | null;
  isConnected(): boolean;
  setFlightMode(mode: FlightMode): Promise<void>;
  requestRTH(): Promise<void>;
  requestLand(): Promise<void>;
  pauseMission(): Promise<void>;
  resumeMission(): Promise<void>;
  abortMission(): Promise<void>;
  onTelemetry(cb: (t: Telemetry) => void): () => void;
  onConnectionChange(cb: (state: ConnectionState) => void): () => void;
}

// ── Camera ─────────────────────────────────────────────────────────────

export interface CameraSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getStats(): CameraStats;
  onFrame(cb: (frame: VideoFrame) => void): () => void;
}

export interface CameraStats {
  resolution: string;
  fps: number;
  streamStatus: "active" | "inactive" | "error";
  latencyMs: number;
  recording: boolean;
  sourceType: string;
}

export interface VideoFrame {
  data: Buffer;
  width: number;
  height: number;
  timestamp: number;
  format: string;
}

// ── Mission ────────────────────────────────────────────────────────────

export interface Waypoint {
  id: string;
  latitude: number;
  longitude: number;
  altitude: number;
  order: number;
  hoverSeconds: number;
}

export interface SearchPolygon {
  id: string;
  name: string;
  coordinates: Array<{ latitude: number; longitude: number }>;
  createdAt: number;
}

export interface Mission {
  id: string;
  name: string;
  description: string;
  status: MissionStatus;
  droneId: string;
  searchArea?: SearchPolygon;
  waypoints: Waypoint[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  detections: string[];          // detection ids
  warnings: string[];            // warning ids
  estimatedDistanceMeters: number;
  estimatedDurationSeconds: number;
  coveragePercent: number;
  batteryEstimatePercent: number;
}

// ── Event ──────────────────────────────────────────────────────────────

export interface MissionEvent {
  id: string;
  missionId: string;
  droneId: string;
  type: EventType;
  severity: Severity;
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ── Alert ──────────────────────────────────────────────────────────────

export interface Alert {
  id: string;
  droneId: string;
  missionId?: string;
  type: string;
  severity: Severity;
  message: string;
  timestamp: number;
  acknowledged: boolean;
}

// ── System Health ──────────────────────────────────────────────────────

export interface SystemHealth {
  cpuPercent: number;
  memoryMB: number;
  visionInferenceMs: number;
  videoFPS: number;
  telemetryLatencyMs: number;
  uptimeSeconds: number;
}

// ── Simulator Config ───────────────────────────────────────────────────

export interface SimulatorConfig {
  startLatitude: number;
  startLongitude: number;
  startAltitude: number;
  /** Ground elevation in metres. Landing terminates here. Defaults to 0. */
  groundElevation: number;
  speedMps: number;
  headingDegrees: number;
  batteryCapacityPercent: number;
  drainRatePerSecond: number;
  gpsNoiseMeters: number;
  connectionLossChance: number;
  windSpeedMps: number;
  windDirectionDegrees: number;
}

// ── WebSocket Messages ─────────────────────────────────────────────────

export interface WSMessage {
  type: string;
  payload: unknown;
  timestamp: number;
  source: string;
}

export interface TelemetryMessage extends WSMessage {
  type: "TELEMETRY";
  payload: Telemetry;
}

export interface DetectionMessage extends WSMessage {
  type: "DETECTION";
  payload: Detection;
}

export interface AlertMessage extends WSMessage {
  type: "ALERT";
  payload: Alert;
}

export interface MissionStateMessage extends WSMessage {
  type: "MISSION_STATE";
  payload: Mission;
}

export interface ConnectionMessage extends WSMessage {
  type: "CONNECTION_STATE";
  payload: { droneId: string; state: ConnectionState };
}
