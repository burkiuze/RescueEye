// RescueEye — Event System
// Structured event logging with filtering by type and severity.

import type { MissionEvent, EventType, Severity } from "../shared/models";

export interface EventFilter {
  missionId?: string;
  droneId?: string;
  type?: EventType;
  severity?: Severity;
  fromTimestamp?: number;
  toTimestamp?: number;
}

export class EventService {
  private events: MissionEvent[] = [];
  private _listeners: Array<(event: MissionEvent) => void> = [];

  addEvent(event: MissionEvent): void {
    this.events.push(event);
    // Keep last 10000 events
    if (this.events.length > 10000) {
      this.events = this.events.slice(-10000);
    }
    this._listeners.forEach((cb) => cb(event));
  }

  getEvents(filter?: EventFilter): MissionEvent[] {
    let result = [...this.events];

    if (filter?.missionId) {
      result = result.filter((e) => e.missionId === filter.missionId);
    }
    if (filter?.droneId) {
      result = result.filter((e) => e.droneId === filter.droneId);
    }
    if (filter?.type) {
      result = result.filter((e) => e.type === filter.type);
    }
    if (filter?.severity) {
      result = result.filter((e) => e.severity === filter.severity);
    }
    if (filter?.fromTimestamp !== undefined) {
      result = result.filter((e) => e.timestamp >= filter.fromTimestamp!);
    }
    if (filter?.toTimestamp !== undefined) {
      result = result.filter((e) => e.timestamp <= filter.toTimestamp!);
    }

    return result.sort((a, b) => b.timestamp - a.timestamp);
  }

  getTimeline(missionId: string): MissionEvent[] {
    return this.getEvents({ missionId }).sort((a, b) => a.timestamp - b.timestamp);
  }

  getEventsByType(type: string): MissionEvent[] {
    return this.getEvents({ type: type as any });
  }

  getEventsBySeverity(severity: string): MissionEvent[] {
    return this.getEvents({ severity: severity as any });
  }

  getSummary(missionId: string): Record<string, number> {
    const events = this.getEvents({ missionId });
    const summary: Record<string, number> = {};
    for (const e of events) {
      summary[e.type] = (summary[e.type] ?? 0) + 1;
    }
    return summary;
  }

  onEvent(cb: (event: MissionEvent) => void): () => void {
    this._listeners.push(cb);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== cb);
    };
  }

  clear(): void {
    this.events = [];
  }
}
