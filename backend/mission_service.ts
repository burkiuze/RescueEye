// RescueEye — Mission Service
// Persistent mission management with state transitions and event logging.

import type {
  Mission,
  MissionStatus,
  Waypoint,
  SearchPolygon,
  MissionEvent,
  Detection,
  Alert,
} from "../shared/models";

export interface MissionStore {
  getMission(id: string): Mission | undefined;
  getAllMissions(): Mission[];
  saveMission(mission: Mission): void;
  updateMission(id: string, updates: Partial<Mission>): Mission | undefined;
  deleteMission(id: string): boolean;
  getMissionsByStatus(status: MissionStatus): Mission[];
}

export interface EventStore {
  getEvents(missionId?: string): MissionEvent[];
  addEvent(event: MissionEvent): void;
  getEventsByType(type: string): MissionEvent[];
  getEventsBySeverity(severity: string): MissionEvent[];
}

export interface WaypointPlanner {
  planSearchArea(
    polygon: SearchPolygon,
    altitude: number,
    overlapMeters: number
  ): { waypoints: Waypoint[]; estimatedDistanceMeters: number; estimatedDurationSeconds: number };
}

// ── In-Memory Mission Store ────────────────────────────────────────────

export class InMemoryMissionStore implements MissionStore {
  private missions: Map<string, Mission> = new Map();

  getMission(id: string): Mission | undefined {
    return this.missions.get(id);
  }

  getAllMissions(): Mission[] {
    return Array.from(this.missions.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
  }

  saveMission(mission: Mission): void {
    this.missions.set(mission.id, mission);
  }

  updateMission(id: string, updates: Partial<Mission>): Mission | undefined {
    const existing = this.missions.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...updates, id };
    this.missions.set(id, updated);
    return updated;
  }

  deleteMission(id: string): boolean {
    return this.missions.delete(id);
  }

  getMissionsByStatus(status: MissionStatus): Mission[] {
    return Array.from(this.missions.values()).filter((m) => m.status === status);
  }
}

// ── In-Memory Event Store ──────────────────────────────────────────────

export class InMemoryEventStore implements EventStore {
  private events: MissionEvent[] = [];

  getEvents(missionId?: string): MissionEvent[] {
    if (missionId) {
      return this.events.filter((e) => e.missionId === missionId);
    }
    return [...this.events];
  }

  addEvent(event: MissionEvent): void {
    this.events.push(event);
    // Keep last 5000 events
    if (this.events.length > 5000) {
      this.events = this.events.slice(-5000);
    }
  }

  getEventsByType(type: string): MissionEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  getEventsBySeverity(severity: string): MissionEvent[] {
    return this.events.filter((e) => e.severity === severity);
  }
}

// ── Waypoint Planner ───────────────────────────────────────────────────
// Generates systematic search patterns (lawnmower / boustrophedon).

export class WaypointPlannerImpl implements WaypointPlanner {
  planSearchArea(
    polygon: SearchPolygon,
    altitude: number,
    overlapMeters: number = 10
  ): { waypoints: Waypoint[]; estimatedDistanceMeters: number; estimatedDurationSeconds: number } {
    const coords = polygon.coordinates;
    if (coords.length < 3) {
      return { waypoints: [], estimatedDistanceMeters: 0, estimatedDurationSeconds: 0 };
    }

    // Compute bounding box of the polygon
    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
    for (const c of coords) {
      minLat = Math.min(minLat, c.latitude);
      maxLat = Math.max(maxLat, c.latitude);
      minLon = Math.min(minLon, c.longitude);
      maxLon = Math.max(maxLon, c.longitude);
    }

    // Generate waypoints in a lawnmower pattern
    const waypoints: Waypoint[] = [];
    const latStep = 0.0001; // ~11 meters
    const lonStep = 0.0001;
    let order = 0;

    for (let lat = minLat; lat <= maxLat; lat += latStep) {
      const startLon = order % 2 === 0 ? minLon : maxLon;
      const endLon = order % 2 === 0 ? maxLon : minLon;
      const numSteps = Math.max(1, Math.round((endLon - startLon) / lonStep));

      for (let i = 0; i <= numSteps; i++) {
        const lon = startLon + (endLon - startLon) * (i / numSteps);
        waypoints.push({
          id: `wp-${order}-${i}`,
          latitude: lat,
          longitude: lon,
          altitude,
          order: order,
          hoverSeconds: 2,
        });
        order++;
      }
    }

    // Estimate distance (simple)
    const totalLat = maxLat - minLat;
    const totalLon = maxLon - minLon;
    const estimatedDistanceMeters =
      Math.sqrt(totalLat * totalLat + totalLon * totalLon) * 111320 * 2; // rough

    const estimatedDurationSeconds = Math.round(estimatedDistanceMeters / 5); // 5 m/s average

    return { waypoints, estimatedDistanceMeters, estimatedDurationSeconds };
  }
}

// ── Mission Manager ────────────────────────────────────────────────────
// High-level mission lifecycle with safety integration.

export interface MissionManagerConfig {
  missionStore: MissionStore;
  eventStore: EventStore;
  waypointPlanner: WaypointPlanner;
}

export class MissionManager {
  private missionStore: MissionStore;
  private eventStore: EventStore;
  private waypointPlanner: WaypointPlanner;

  constructor(config: MissionManagerConfig) {
    this.missionStore = config.missionStore;
    this.eventStore = config.eventStore;
    this.waypointPlanner = config.waypointPlanner;
  }

  createMission(data: {
    name: string;
    description?: string;
    droneId: string;
    searchArea?: SearchPolygon;
    waypoints?: Waypoint[];
  }): Mission {
    const mission: Mission = {
      id: `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: data.name,
      description: data.description ?? "",
      status: "PLANNED",
      droneId: data.droneId,
      searchArea: data.searchArea,
      waypoints: data.waypoints ?? [],
      createdAt: Date.now(),
      detections: [],
      warnings: [],
      estimatedDistanceMeters: 0,
      estimatedDurationSeconds: 0,
      coveragePercent: 0,
      batteryEstimatePercent: 100,
    };

    this.missionStore.saveMission(mission);
    this._addEvent(mission.id, "MISSION_START", "INFO", `Mission "${mission.name}" created`);

    return mission;
  }

  startMission(missionId: string): Mission | undefined {
    const mission = this.missionStore.getMission(missionId);
    if (!mission) return undefined;
    if (mission.status !== "PLANNED" && mission.status !== "READY") return undefined;

    mission.status = "ACTIVE";
    mission.startedAt = Date.now();
    this.missionStore.updateMission(missionId, mission);
    this._addEvent(missionId, "MISSION_START", "INFO", `Mission "${mission.name}" started`);

    return mission;
  }

  pauseMission(missionId: string): Mission | undefined {
    const mission = this.missionStore.getMission(missionId);
    if (!mission) return undefined;
    if (mission.status !== "ACTIVE") return undefined;

    mission.status = "PAUSED";
    this.missionStore.updateMission(missionId, mission);
    this._addEvent(missionId, "MISSION_PAUSE", "WARNING", `Mission "${mission.name}" paused`);

    return mission;
  }

  resumeMission(missionId: string): Mission | undefined {
    const mission = this.missionStore.getMission(missionId);
    if (!mission) return undefined;
    if (mission.status !== "PAUSED") return undefined;

    mission.status = "ACTIVE";
    this.missionStore.updateMission(missionId, mission);
    this._addEvent(missionId, "MISSION_START", "INFO", `Mission "${mission.name}" resumed`);

    return mission;
  }

  completeMission(missionId: string): Mission | undefined {
    const mission = this.missionStore.getMission(missionId);
    if (!mission) return undefined;
    if (mission.status !== "ACTIVE" && mission.status !== "PAUSED") return undefined;

    mission.status = "COMPLETED";
    mission.completedAt = Date.now();
    this.missionStore.updateMission(missionId, mission);
    this._addEvent(missionId, "MISSION_COMPLETE", "INFO", `Mission "${mission.name}" completed`);

    return mission;
  }

  abortMission(missionId: string): Mission | undefined {
    const mission = this.missionStore.getMission(missionId);
    if (!mission) return undefined;

    mission.status = "ABORTED";
    this.missionStore.updateMission(missionId, mission);
    this._addEvent(missionId, "MISSION_ABORT", "ERROR", `Mission "${mission.name}" aborted`);

    return mission;
  }

  getMission(id: string): Mission | undefined {
    return this.missionStore.getMission(id);
  }

  getAllMissions(): Mission[] {
    return this.missionStore.getAllMissions();
  }

  getActiveMissions(): Mission[] {
    return this.missionStore.getMissionsByStatus("ACTIVE");
  }

  addDetectionToMission(missionId: string, detection: { id: string; class: string; confidence: number }): void {
    const mission = this.missionStore.getMission(missionId);
    if (!mission) return;
    mission.detections.push(detection.id);
    this.missionStore.updateMission(missionId, mission);
  }

  addWarningToMission(missionId: string, warning: string): void {
    const mission = this.missionStore.getMission(missionId);
    if (!mission) return;
    mission.warnings.push(warning);
    this.missionStore.updateMission(missionId, mission);
  }

  planSearchArea(
    polygon: SearchPolygon,
    altitude: number,
    overlapMeters: number = 10
  ): { waypoints: Waypoint[]; estimatedDistanceMeters: number; estimatedDurationSeconds: number } {
    return this.waypointPlanner.planSearchArea(polygon, altitude, overlapMeters);
  }

  private _addEvent(missionId: string, type: string, severity: string, message: string): void {
    this.eventStore.addEvent({
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      missionId,
      droneId: "",
      type: type as any,
      severity: severity as any,
      message,
      timestamp: Date.now(),
    });
  }
}
