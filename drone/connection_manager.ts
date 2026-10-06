// RescueEye — Drone Adapter Factory
// Creates the appropriate adapter based on configuration.

import type { ConnectionState } from "../shared/models";
import type { DroneAdapter, DroneAdapterFactory, AdapterType } from "./adapter";
import { MavlinkDroneAdapter } from "./mavlink_adapter";
import { MavsdkDroneAdapter } from "./mavsdk_adapter";
import type { MavlinkConfig, MavsdkConfig } from "./adapter";

export class DroneAdapterFactoryImpl implements DroneAdapterFactory {
  create(type: AdapterType, config?: Record<string, unknown>): DroneAdapter {
    // Config arrives as an untyped bag from the caller; validate the fields the
    // concrete adapter actually needs rather than blind-casting, so a typo in
    // configuration fails loudly at startup instead of at first flight command.
    switch (type) {
      case "mavlink": {
        const cfg = requireMavlinkConfig(config);
        return new MavlinkDroneAdapter(str(config?.droneId, "mavlink-001"), cfg);
      }
      case "mavsdk": {
        const cfg = requireMavsdkConfig(config);
        return new MavsdkDroneAdapter(str(config?.droneId, "mavsdk-001"), cfg);
      }
      case "simulator":
        throw new Error(
          "SimulatorDroneAdapter is constructed directly; it takes SimulatorConfig, not this factory",
        );
      default:
        throw new Error(`Unknown adapter type: ${String(type)}`);
    }
  }
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function num(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function requireMavlinkConfig(config?: Record<string, unknown>): MavlinkConfig {
  return {
    udpPort: num(config?.udpPort, 14550, "udpPort"),
    tcpHost: typeof config?.tcpHost === "string" ? config.tcpHost : undefined,
    tcpPort: config?.tcpPort === undefined ? undefined : num(config.tcpPort, 5760, "tcpPort"),
    systemId: num(config?.systemId, 1, "systemId"),
    componentId: num(config?.componentId, 1, "componentId"),
    heartbeatIntervalMs: num(config?.heartbeatIntervalMs, 1000, "heartbeatIntervalMs"),
    reconnectOnDisconnect: bool(config?.reconnectOnDisconnect, true),
  };
}

function requireMavsdkConfig(config?: Record<string, unknown>): MavsdkConfig {
  return {
    serverAddress: str(config?.serverAddress, "127.0.0.1"),
    port: num(config?.port, 50051, "port"),
    droneId: num(config?.droneId, 1, "droneId"),
  };
}

// ── Connection Manager ─────────────────────────────────────────────────
// Manages lifecycle of a single drone connection with reconnect logic.

export interface ConnectionManagerConfig {
  adapter: DroneAdapter;
  reconnectOnDisconnect: boolean;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
}

export class ConnectionManager {
  private adapter: DroneAdapter;
  private config: ConnectionManagerConfig;
  private _reconnectAttempts = 0;
  private _reconnectTimer: number | NodeJS.Timeout | null = null;
  private _unsubscribers: Array<() => void> = [];
  private _onStateChange?: (state: ConnectionState) => void;

  constructor(adapter: DroneAdapter, config: ConnectionManagerConfig) {
    this.adapter = adapter;
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      await this.adapter.connect();
      this._reconnectAttempts = 0;
      this._startMonitoring();
    } catch (err) {
      this._handleDisconnect(String(err));
    }
  }

  async disconnect(): Promise<void> {
    this._stopReconnect();
    this._unsubscribers.forEach((u) => u());
    this._unsubscribers = [];
    await this.adapter.disconnect();
  }

  getAdapter(): DroneAdapter {
    return this.adapter;
  }

  private _startMonitoring(): void {
    const unsubConn = this.adapter.onConnectionChange((state) => {
      if (state === "DISCONNECTED") {
        this._handleDisconnect("Connection lost");
      }
    });
    this._unsubscribers.push(unsubConn);
  }

  private _handleDisconnect(reason: string): void {
    if (
      this.config.reconnectOnDisconnect &&
      this._reconnectAttempts < this.config.maxReconnectAttempts
    ) {
      this._reconnectAttempts++;
      this._reconnectTimer = setTimeout(() => {
        this.connect().catch(() => {
          // will retry again on next disconnect
        });
      }, this.config.reconnectIntervalMs);
    }
  }

  private _stopReconnect(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}
