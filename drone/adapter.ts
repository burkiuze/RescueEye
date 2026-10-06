// RescueEye — Drone Abstraction Layer
// Clean interfaces separating the application from autopilot implementation.

// The adapter contract lives in shared/models and is re-exported here so that
// drone-layer code can import everything it needs from a single module.
import type {
  DroneAdapter,
  Telemetry,
  FlightMode,
  ConnectionState,
  CameraSource,
  CameraStats,
  VideoFrame,
} from "../shared/models";

export type {
  DroneAdapter,
  Telemetry,
  FlightMode,
  ConnectionState,
  CameraSource,
  CameraStats,
  VideoFrame,
};

// ── Adapter Factory ────────────────────────────────────────────────────

export type AdapterType = "mavlink" | "simulator" | "mavsdk" | "ardupilot";

export interface DroneAdapterFactory {
  create(type: AdapterType, config?: Record<string, unknown>): DroneAdapter;
}

// ── MAVLink Adapter Config ─────────────────────────────────────────────

export interface MavlinkConfig {
  udpPort: number;
  tcpHost?: string;
  tcpPort?: number;
  systemId: number;
  componentId: number;
  heartbeatIntervalMs: number;
  reconnectOnDisconnect: boolean;
}

// ── MAVSDK Adapter Config ──────────────────────────────────────────────

export interface MavsdkConfig {
  serverAddress: string;
  port: number;
  droneId: number;
}

// ── Connection Info ────────────────────────────────────────────────────

export interface ConnectionInfo {
  adapterType: AdapterType;
  connected: boolean;
  connectedAt?: number;
  disconnectReason?: string;
  retryCount: number;
  lastTelemetryAt?: number;
}

// ── Telemetry Parser ───────────────────────────────────────────────────

export interface TelemetryParser {
  parse(raw: Buffer | string): Telemetry | null;
  supportsFormat(format: string): boolean;
}

// ── Autopilot Protocol ─────────────────────────────────────────────────

export interface AutopilotProtocol {
  readonly name: string;
  readonly version: string;
  sendCommand(command: string, params?: Record<string, unknown>): Promise<boolean>;
  startTelemetryStream(rateHz: number): Promise<void>;
  stopTelemetryStream(): Promise<void>;
  onMessage(cb: (msg: unknown) => void): () => void;
}
