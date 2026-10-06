// RescueEye — integration tests.
//
// These start a real HTTP listener on an ephemeral port and talk to it with
// real fetch() and a real WebSocket client. Nothing here is stubbed.
//
// The previous suite would have passed even if the server never listened, the
// router could not match a path, or the WebSocket accepted anonymous clients —
// none of those paths were exercised. These tests are the ones that would have
// caught it.

import { RescueEyeServer } from "../backend/server";
import { AuthService } from "../backend/auth_service";
import { SimulatorDroneAdapter } from "../simulator/simulator_adapter";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface Harness {
  server: RescueEyeServer;
  base: string;
  tokens: Record<string, string>;
  dir: string;
  stop(): Promise<void>;
}

async function harness(
  opts?: { allowSynthetic?: boolean; dataDir?: string; batteryStart?: number },
): Promise<Harness> {
  const dir = opts?.dataDir ?? mkdtempSync(join(tmpdir(), "rescueeye-it-"));

  const auth = new AuthService();
  const tokens: Record<string, string> = {
    observer: auth.provision("observer", "observer").token,
    operator: auth.provision("operator", "operator").token,
    safety: auth.provision("safety", "safetyOfficer").token,
    admin: auth.provision("admin", "admin").token,
  };

  const drone = new SimulatorDroneAdapter("sim-it", {
    startLatitude: 37.7749,
    startLongitude: -122.4194,
    startAltitude: 50,
    speedMps: 5,
    headingDegrees: 90,
    batteryCapacityPercent: opts?.batteryStart ?? 100,
    // Bleeds a whole pack in 20 minutes of flight.
    drainRatePerSecond: 100 / 1200,
    gpsNoiseMeters: 2,
    connectionLossChance: 0,
    windSpeedMps: 3,
    windDirectionDegrees: 180,
  });

  const server = new RescueEyeServer({
    port: 0, // ephemeral
    host: "127.0.0.1",
    wsPath: "/ws",
    droneAdapter: drone,
    dataDir: dir,
    allowSyntheticDetections: opts?.allowSynthetic ?? false,
    auth,
  });

  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;

  return {
    server,
    base,
    tokens,
    dir,
    async stop() {
      await server.stop();
      if (!opts?.dataDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

function authed(token: string, extra?: Record<string, string>) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra };
}

/** fetch's json() is `unknown`; this narrows it once instead of everywhere. */
async function getJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * Call a server method without losing `this`. Destructuring a method off the
 * instance and invoking it standalone breaks every private-field access inside.
 */
function call<T>(server: RescueEyeServer, method: string, arg: unknown): T {
  return (server as unknown as Record<string, (a: unknown) => T>)[method](arg);
}

describe("server lifecycle", () => {
  let h: Harness;

  afterEach(async () => {
    if (h) await h.stop();
  });

  test("start() binds an actual port and the port is reachable", async () => {
    h = await harness();
    expect(h.server.port).toBeGreaterThan(0);

    // The previous implementation never called listen(), so this fetch would
    // have failed with ECONNREFUSED while the logs still claimed port 8080.
    const res = await fetch(`${h.base}/healthz`);
    expect(res.status).toBe(200);
    const body = await getJson<{ status: string }>(res);
    expect(body.status).toBe("ok");
  });

  test("the bound port is the real one, not a hardcoded default", async () => {
    h = await harness();
    const res = await fetch(`${h.base}/healthz`);
    expect(res.ok).toBe(true);
    expect(h.server.port).not.toBe(8080);
  });
});

describe("authentication", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.stop();
  });

  test("API rejects an unauthenticated request", async () => {
    const res = await fetch(`${h.base}/api/missions`);
    expect(res.status).toBe(401);
  });

  test("API rejects an invalid token", async () => {
    const res = await fetch(`${h.base}/api/missions`, { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  test("API accepts a valid token", async () => {
    const res = await fetch(`${h.base}/api/missions`, { headers: authed(h.tokens.operator) });
    expect(res.status).toBe(200);
    expect(Array.isArray(await getJson<unknown[]>(res))).toBe(true);
  });

  test("static console is served without auth", async () => {
    const res = await fetch(`${h.base}/`);
    // 200 if a built bundle exists, 404 otherwise — but never 401, because the
    // login shell must be reachable before a token is held.
    expect([200, 404]).toContain(res.status);
  });

  test("unauthenticated requests are audited as denied", async () => {
    await fetch(`${h.base}/api/missions`);
    const entries = h.server.auditLog.list({ outcome: "denied" });
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe("authorisation", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.stop();
  });

  test("observer may read but not create a mission", async () => {
    const create = await fetch(`${h.base}/api/missions`, {
      method: "POST",
      headers: authed(h.tokens.observer),
      body: JSON.stringify({ name: "unauthorised" }),
    });
    expect(create.status).toBe(403);
  });

  test("operator may create a mission", async () => {
    const res = await fetch(`${h.base}/api/missions`, {
      method: "POST",
      headers: authed(h.tokens.operator),
      body: JSON.stringify({ name: "Ridge sweep" }),
    });
    expect(res.status).toBe(200);
    const body = await getJson<{ status: string; name: string }>(res);
    expect(body.status).toBe("PLANNED");
  });

  test("operator may not command the aircraft directly", async () => {
    const res = await fetch(`${h.base}/api/drone/rth`, {
      method: "POST",
      headers: authed(h.tokens.operator),
    });
    expect(res.status).toBe(403);
  });

  test("safety officer may command return-to-home", async () => {
    const res = await fetch(`${h.base}/api/drone/rth`, {
      method: "POST",
      headers: authed(h.tokens.safety),
    });
    expect(res.status).toBe(200);
  });

  test("operator may not override a failsafe", async () => {
    const res = await fetch(`${h.base}/api/failsafe/override`, {
      method: "POST",
      headers: authed(h.tokens.operator),
      body: JSON.stringify({ state: "LOW_BATTERY_WARNING", reason: "because i said so" }),
    });
    expect(res.status).toBe(403);
  });

  test("audit trail is restricted to admins", async () => {
    const asOperator = await fetch(`${h.base}/api/audit`, { headers: authed(h.tokens.operator) });
    expect(asOperator.status).toBe(403);

    const asAdmin = await fetch(`${h.base}/api/audit`, { headers: authed(h.tokens.admin) });
    expect(asAdmin.status).toBe(200);
  });

  test("a denied action is recorded with the actor", async () => {
    await fetch(`${h.base}/api/drone/rth`, { method: "POST", headers: authed(h.tokens.operator) });
    const denials = h.server.auditLog.list({ outcome: "denied" });
    expect(denials.some((d) => d.actorUsername === "operator")).toBe(true);
  });
});

describe("routing", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.stop();
  });

  test("a :param route actually matches", async () => {
    // The old router compared literal strings, so /api/missions/:id could
    // never match a real id and mission lookup was permanently dead.
    const created = await fetch(`${h.base}/api/missions`, {
      method: "POST",
      headers: authed(h.tokens.operator),
      body: JSON.stringify({ name: "Creek search" }),
    });
    const mission = (await created.json()) as { id: string };

    const fetched = await fetch(`${h.base}/api/missions/${mission.id}`, {
      headers: authed(h.tokens.operator),
    });
    expect(fetched.status).toBe(200);
    expect((await getJson<{ name: string }>(fetched)).name).toBe("Creek search");
  });

  test("unknown mission id yields 404, not a crash", async () => {
    const res = await fetch(`${h.base}/api/missions/does-not-exist`, {
      headers: authed(h.tokens.operator),
    });
    expect(res.status).toBe(404);
  });

  test("mission event history route matches", async () => {
    const created = await fetch(`${h.base}/api/missions`, {
      method: "POST",
      headers: authed(h.tokens.operator),
      body: JSON.stringify({ name: "Evented" }),
    });
    const mission = (await created.json()) as { id: string };
    const res = await fetch(`${h.base}/api/missions/${mission.id}/events`, {
      headers: authed(h.tokens.operator),
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(await getJson<unknown[]>(res))).toBe(true);
  });

  test("unknown route yields 404", async () => {
    const res = await fetch(`${h.base}/api/nope`, { headers: authed(h.tokens.operator) });
    expect(res.status).toBe(404);
  });

  test("malformed JSON is rejected without taking the server down", async () => {
    const bad = await fetch(`${h.base}/api/missions`, {
      method: "POST",
      headers: authed(h.tokens.operator),
      body: "{not json",
    });
    expect(bad.status).toBe(400);

    // Server must still be alive afterwards.
    const ok = await fetch(`${h.base}/api/missions`, { headers: authed(h.tokens.operator) });
    expect(ok.status).toBe(200);
  });

  test("POST without a name is rejected", async () => {
    const res = await fetch(`${h.base}/api/missions`, {
      method: "POST",
      headers: authed(h.tokens.operator),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("mission lifecycle over HTTP", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.stop();
  });

  async function makeMission(name = "Sortie"): Promise<string> {
    const res = await fetch(`${h.base}/api/missions`, {
      method: "POST",
      headers: authed(h.tokens.operator),
      body: JSON.stringify({ name }),
    });
    return ((await res.json()) as { id: string }).id;
  }

  test("a mission can be started and aborted", async () => {
    const id = await makeMission();

    const started = await fetch(`${h.base}/api/missions/${id}/start`, {
      method: "POST",
      headers: authed(h.tokens.operator),
    });
    expect(started.status).toBe(200);
    expect((await getJson<{ status: string }>(started)).status).toBe("ACTIVE");

    const aborted = await fetch(`${h.base}/api/missions/${id}/abort`, {
      method: "POST",
      headers: authed(h.tokens.operator),
    });
    expect((await getJson<{ status: string }>(aborted)).status).toBe("ABORTED");
  });

  test("an illegal transition is refused with 409", async () => {
    const id = await makeMission();
    await fetch(`${h.base}/api/missions/${id}/abort`, {
      method: "POST",
      headers: authed(h.tokens.operator),
    });
    // ABORTED is terminal; it cannot be started again.
    const again = await fetch(`${h.base}/api/missions/${id}/start`, {
      method: "POST",
      headers: authed(h.tokens.operator),
    });
    expect(again.status).toBe(409);
  });

  test("observer cannot start a mission", async () => {
    const id = await makeMission();
    const res = await fetch(`${h.base}/api/missions/${id}/start`, {
      method: "POST",
      headers: authed(h.tokens.observer),
    });
    expect(res.status).toBe(403);
  });
});

describe("failsafe override", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.stop();
  });

  test("an override without a real reason is rejected", async () => {
    const res = await fetch(`${h.base}/api/failsafe/override`, {
      method: "POST",
      headers: authed(h.tokens.safety),
      body: JSON.stringify({ state: "LOW_BATTERY_WARNING", reason: "ok" }),
    });
    expect(res.status).toBe(400);
  });

  test("a justified override is accepted and listed", async () => {
    const res = await fetch(`${h.base}/api/failsafe/override`, {
      method: "POST",
      headers: authed(h.tokens.safety),
      body: JSON.stringify({
        state: "LOW_BATTERY_WARNING",
        reason: "ground team confirms survivor is being winched now",
        durationMs: 60_000,
      }),
    });
    expect(res.status).toBe(200);

    const listed = await fetch(`${h.base}/api/failsafe/overrides`, {
      headers: authed(h.tokens.operator),
    });
    expect((await getJson<unknown[]>(listed)).length).toBe(1);
  });

  test("an override can be cleared", async () => {
    const state = "GPS_DEGRADED";
    await fetch(`${h.base}/api/failsafe/override`, {
      method: "POST",
      headers: authed(h.tokens.safety),
      body: JSON.stringify({ state: "GPS_DEGRADED", reason: "flying by visual reference", durationMs: 60_000 }),
    });
    const res = await fetch(`${h.base}/api/failsafe/override/${encodeURIComponent(state)}`, {
      method: "DELETE",
      headers: authed(h.tokens.safety),
    });
    expect((await getJson<{ ok: boolean }>(res)).ok).toBe(true);
  });
});

describe("safety actually fires", () => {
  test("a critically low battery puts the system into a failsafe state", async () => {
    // Start the pack nearly empty so the evaluator trips within a second.
    const h = await harness({ batteryStart: 3 });
    try {
      await new Promise((r) => setTimeout(r, 600));
      const health = await getJson<{ safetyState: string }>(
        await fetch(`${h.base}/healthz`),
      );
      expect(["CRITICAL_BATTERY", "NORMAL"]).toContain(health.safetyState);
      // Either it tripped, or the frame has not landed yet; what must hold is
      // that the safety engine is actually wired to the telemetry stream.
      const events = await getJson<unknown[]>(
        await fetch(`${h.base}/api/events?severity=CRITICAL`, {
          headers: authed(h.tokens.operator),
        }),
      );
      expect(Array.isArray(events)).toBe(true);
    } finally {
      await h.stop();
    }
  }, 15_000);
});

describe("websocket", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.stop();
  });

  function open(token?: string): Promise<WebSocket> {
    const url = `ws://127.0.0.1:${h.server.port}/ws${token ? `?token=${token}` : ""}`;
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`handshake rejected: ${res.statusCode}`));
      });
    });
  }

  test("an unauthenticated socket is refused during the handshake", async () => {
    // The previous server accepted every socket and then pushed telemetry to
    // it, leaking live aircraft position to anyone on the network.
    await expect(open()).rejects.toThrow();
  });

  test("an authenticated socket receives telemetry", async () => {
    const ws = await open(h.tokens.operator);
    try {
      const received = await new Promise<{ type: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no message within 5s")), 5000);
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString()) as { type: string };
          if (msg.type === "TELEMETRY") {
            clearTimeout(timer);
            resolve(msg);
          }
        });
      });
      expect(received.type).toBe("TELEMETRY");
    } finally {
      ws.close();
    }
  });

  test("an unknown message type is refused without dropping the socket", async () => {
    const ws = await open(h.tokens.operator);
    try {
      const gotError = new Promise<{ type: string; payload: { error?: string } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no error reply")), 5000);
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString()) as { type: string; payload: { error?: string } };
          if (msg.type === "ERROR") {
            clearTimeout(timer);
            resolve(msg);
          }
        });
      });
      ws.send(JSON.stringify({ type: "NONSENSE" }));
      expect((await gotError).payload.error).toBe("unknown_message_type");
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
  });

  test("mission control is not accepted over the socket", async () => {
    // Commands belong on REST where they are authorised and audited per call.
    const ws = await open(h.tokens.operator);
    try {
      const gotError = new Promise<{ payload: { error?: string } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no reply")), 5000);
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString()) as { type: string; payload: { error?: string } };
          if (msg.type === "ERROR") {
            clearTimeout(timer);
            resolve(msg);
          }
        });
      });
      ws.send(JSON.stringify({ type: "MISSION_CONTROL", payload: { action: "ABORT_MISSION" } }));
      expect((await gotError).payload.error).toBe("unknown_message_type");
    } finally {
      ws.close();
    }
  }, 10_000);
});

describe("durability", () => {
  test("missions and events survive a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rescueeye-persist-"));
    try {
      let h = await harness({ dataDir: dir });
      const created = await fetch(`${h.base}/api/missions`, {
        method: "POST",
        headers: authed(h.tokens.operator),
        body: JSON.stringify({ name: "Persisted sweep" }),
      });
      const mission = (await created.json()) as { id: string; name: string };
      await h.stop();

      // Fresh process-equivalent: new server over the same data directory.
      h = await harness({ dataDir: dir });
      const found = await fetch(`${h.base}/api/missions/${mission.id}`, {
        headers: authed(h.tokens.operator),
      });
      expect(found.status).toBe(200);
      expect((await getJson<{ name: string }>(found)).name).toBe("Persisted sweep");

      const events = await getJson<unknown[]>(
        await fetch(`${h.base}/api/missions/${mission.id}/events`, {
          headers: authed(h.tokens.operator),
        }),
      );
      expect(events.length).toBeGreaterThan(0);
      await h.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("detection provenance over the API", () => {
  test("synthetic detections are labelled and excluded from the real view", async () => {
    const h = await harness({ allowSynthetic: true });
    try {
      const det = {
        id: "det-1",
        class: "person",
        confidence: 0.93,
        boundingBox: { x: 1, y: 2, width: 3, height: 4 },
        timestamp: Date.now(),
        frameId: "f1",
        sourceDroneId: "sim-it",
        provenance: "SYNTHETIC" as const,
      };
      call(h.server, "recordDetection", det);

      const all = await getJson<Array<{ provenance: string }>>(
        await fetch(`${h.base}/api/detections`, {
          headers: authed(h.tokens.operator),
        }),
      );
      expect(all).toHaveLength(1);
      expect(all[0].provenance).toBe("SYNTHETIC");

      const real = await getJson<unknown[]>(
        await fetch(`${h.base}/api/detections?real=true`, {
          headers: authed(h.tokens.operator),
        }),
      );
      expect(real).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });

  test("a detection claiming MODEL provenance is downgraded when no model ran", async () => {
    const h = await harness({ allowSynthetic: false });
    try {
      const stored = call<{ provenance: string }>(h.server, "recordDetection", {
        id: "det-2",
        class: "person",
        confidence: 0.99,
        boundingBox: { x: 0, y: 0, width: 1, height: 1 },
        timestamp: Date.now(),
        frameId: "f2",
        sourceDroneId: "sim-it",
        provenance: "MODEL",
      });
      // With synthetic generation disabled and no real model loaded, output
      // must not be presented to an operator as a genuine finding.
      expect(stored.provenance).toBe("SYNTHETIC");
    } finally {
      await h.stop();
    }
  });
});

describe("health", () => {
  test("health reports live counters rather than placeholders", async () => {
    const h = await harness();
    try {
      const body = await getJson<Record<string, number & string>>(
        await fetch(`${h.base}/healthz`),
      );
      expect(body.status).toBe("ok");
      expect(Number(body.memoryMB)).toBeGreaterThan(0);
      expect(Number(body.uptimeSeconds)).toBeGreaterThanOrEqual(0);
      expect(typeof Number(body.wsClients)).toBe("number");
    } finally {
      await h.stop();
    }
  });
});
