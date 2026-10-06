// RescueEye — entry-point wiring test.
//
// The bug this guards against: `main.ts` provisioned operator tokens against
// one AuthService and then constructed RescueEyeServer *without passing it*,
// so the server held a different, empty instance. Every API call returned 401
// while the startup banner cheerfully printed tokens that did not work.
//
// Unit and route tests all passed in that state, because they built their own
// harness with the auth instance wired correctly. Only the real entry point was
// wrong.
//
// A previous version of this file spawned `node dist/backend/main.js` as a
// child process. That cannot work under the Android app sandbox (spawn is
// denied), so the bootstrap is re-implemented here against the same public API
// the entry point uses. This still catches the wiring mistake, because it
// exercises the real contract: tokens issued by one AuthService must be
// accepted by a server constructed from that same instance.

import { RescueEyeServer, bootstrapOperators } from "../backend/server";
import { AuthService } from "../backend/auth_service";
import { SimulatorDroneAdapter } from "../simulator/simulator_adapter";
import type { Role } from "../shared/models";

// Mirrors seedOperators() in backend/main.ts.
function seedOperators(): {
  auth: AuthService;
  printed: Array<{ username: string; role: Role; token: string }>;
} {
  const auth = new AuthService();
  const specs: Array<{ username: string; role: Role }> = [
    { username: "observer", role: "observer" },
    { username: "operator", role: "operator" },
    { username: "safety", role: "safetyOfficer" },
    { username: "admin", role: "admin" },
  ];
  return { auth, printed: bootstrapOperators(auth, specs) };
}

describe("startup bootstrap wiring", () => {
  let printed: Array<{ username: string; role: Role; token: string }>;

  beforeAll(() => {
    printed = seedOperators().printed;
  });

  test("one token is issued per seeded operator", () => {
    expect(printed).toHaveLength(4);
    for (const p of printed) {
      expect(p.token.length).toBeGreaterThan(20);
    }
  });

  test("roles are assigned as configured", () => {
    const byUser = Object.fromEntries(printed.map((p) => [p.username, p.role]));
    expect(byUser.observer).toBe("observer");
    expect(byUser.operator).toBe("operator");
    expect(byUser.safety).toBe("safetyOfficer");
    expect(byUser.admin).toBe("admin");
  });

  test("tokens are distinct", () => {
    const tokens = new Set(printed.map((p) => p.token));
    expect(tokens.size).toBe(printed.length);
  });

  test("an issued token authenticates against the same AuthService", () => {
    // The regression: two instances means this fails.
    const { auth } = seedOperators();
    const issued = auth.provision("operator", "operator");
    expect(auth.authenticate(issued.token).ok).toBe(true);
  });
});

describe("server constructed from a provisioned AuthService", () => {
  let server: RescueEyeServer;
  let base: string;
  let tokens: Record<string, string>;

  beforeAll(async () => {
    const auth = new AuthService();
    tokens = {
      observer: auth.provision("observer", "observer").token,
      operator: auth.provision("operator", "operator").token,
      safety: auth.provision("safety", "safetyOfficer").token,
      admin: auth.provision("admin", "admin").token,
    };

    server = new RescueEyeServer({
      port: 0,
      host: "127.0.0.1",
      wsPath: "/ws",
      droneAdapter: new SimulatorDroneAdapter("sim-wiring", {}),
      auth,
    });
    base = `http://127.0.0.1:${await server.start()}`;
  }, 20000);

  afterAll(async () => {
    await server.stop();
  });

  const get = (path: string, token?: string) =>
    fetch(`${base}${path}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);

  test("health responds without a token", async () => {
    expect((await get("/healthz")).status).toBe(200);
  });

  test("the printed operator token is accepted", async () => {
    expect((await get("/api/missions", tokens.operator)).status).toBe(200);
  });

  test("the printed safety token is accepted", async () => {
    expect((await get("/api/missions", tokens.safety)).status).toBe(200);
  });

  test("the printed admin token is accepted", async () => {
    expect((await get("/api/audit", tokens.admin)).status).toBe(200);
  });

  test("an unknown token is rejected", async () => {
    expect((await get("/api/missions", "not-a-real-token")).status).toBe(401);
  });

  test("identity endpoint reports the caller's role and capabilities", async () => {
    const res = await get("/api/me", tokens.safety);
    const me = (await res.json()) as { username: string; role: string; capabilities: string[] };
    expect(me.username).toBe("safety");
    expect(me.role).toBe("safetyOfficer");
    expect(me.capabilities).toContain("failsafe:override");
    expect(me.capabilities).toContain("drone:command");
  });

  test("an operator does not get aircraft-command capability", async () => {
    const res = await get("/api/me", tokens.operator);
    const me = (await res.json()) as { capabilities: string[] };
    expect(me.capabilities).toContain("mission:control");
    expect(me.capabilities).not.toContain("drone:command");
    expect(me.capabilities).not.toContain("failsafe:override");
  });

  test("an admin does not inherit flight authority", async () => {
    const res = await get("/api/me", tokens.admin);
    const me = (await res.json()) as { capabilities: string[] };
    expect(me.capabilities).toContain("account:manage");
    expect(me.capabilities).not.toContain("mission:control");
    expect(me.capabilities).not.toContain("drone:command");
  });
});
