// RescueEye — Drone Adapter Factory
// Creates the appropriate adapter based on configuration.

import type { DroneAdapter, DroneAdapterFactory, AdapterType } from "./adapter";
import { MavlinkDroneAdapter } from "./mavlink_adapter";
import { MavsdkDroneAdapter } from "./mavsdk_adapter";
import type { MavlinkConfig, MavsdkConfig } from "./adapter";

export class DroneAdapterFactoryImpl implements DroneAdapterFactory {
  create(type: AdapterType, config?: Record<string, unknown>): DroneAdapter {
    switch (type) {
      case "mavlink":
        return new MavlinkDroneAdapter(
          (config?.droneId as string) ?? "mavlink-001",
          config as MavlinkConfig
        );
      case "mavsdk":
        return new MavsdkDroneAdapter(
          (config?.droneId as string) ?? "mavsdk-001",
          config as MavsdkConfig
        );
      case "simulator":
        // Simulator is created separately; this factory handles real adapters.
        throw new Error("Use SimulatorDroneAdapter for simulator mode");
      default:
        throw new Error(`Unknown adapter type: ${type}`);
    }
  }
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
