// RescueEye — server entry point.
//
// Starts the command-centre backend: drone adapter (simulator by default),
// REST + WebSocket API, authentication bootstrap, and the static console.
//
// The previous version never called listen(), printed a hardcoded port, and
// attached a second 'request' handler that shadowed the router. Both are fixed
// here: exactly one handler exists, and it is the server's.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { RescueEyeServer, bootstrapOperators } from "./server";
import { AuthService } from "./auth_service";
import { SimulatorDroneAdapter } from "../simulator/simulator_adapter";
import type { Role } from "../shared/models";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const WS_PATH = process.env.WS_PATH ?? "/ws";
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve("./data");
const DRONE_MODE = (process.env.DRONE_MODE ?? "simulator").toLowerCase();

if (DATA_DIR) mkdirSync(DATA_DIR, { recursive: true });

/**
 * Seed accounts.
 *
 * In production these must be provisioned out of band and the tokens handed to
 * operators through a secure channel. For a local/demo run we generate them at
 * startup and print them once — the server does not store the plaintext.
 */
function seedOperators(): { auth: AuthService; printed: Array<{ username: string; role: Role; token: string }> } {
  const auth = new AuthService();
  const specs: Array<{ username: string; role: Role }> = [
    { username: "observer", role: "observer" },
    { username: "operator", role: "operator" },
    { username: "safety", role: "safetyOfficer" },
    { username: "admin", role: "admin" },
  ];
  return { auth, printed: bootstrapOperators(auth, specs) };
}

async function main(): Promise<void> {
  const { auth, printed } = seedOperators();

  // Only the simulator is implemented; a real MAVLink/MAVSDK transport must be
  // added before DRONE_MODE can be anything else. Refuse loudly rather than
  // pretending to fly.
  if (DRONE_MODE !== "simulator") {
    throw new Error(
      `DRONE_MODE='${DRONE_MODE}' is not implemented. Only 'simulator' is available; ` +
        `see docs/architecture.md for adding a real adapter.`,
    );
  }

  const drone = new SimulatorDroneAdapter(
    process.env.DRONE_ID ?? "sim-drone-001",
    {
      startLatitude: Number(process.env.START_LAT ?? 37.7749),
      startLongitude: Number(process.env.START_LON ?? -122.4194),
      startAltitude: Number(process.env.START_ALT ?? 50),
      speedMps: Number(process.env.SPEED_MPS ?? 5),
      headingDegrees: Number(process.env.HEADING_DEG ?? 90),
      batteryCapacityPercent: 100,
      // A real sortie burns a full pack in roughly 20 minutes of flight.
      drainRatePerSecond: Number(process.env.BATTERY_DRAIN ?? 100 / 1200),
      gpsNoiseMeters: 2,
      connectionLossChance: Number(process.env.CONN_LOSS_CHANCE ?? 0.0005),
      windSpeedMps: 3,
      windDirectionDegrees: 180,
    },
  );

  const server = new RescueEyeServer({
    port: PORT,
    host: HOST,
    wsPath: WS_PATH,
    droneAdapter: drone,
    dataDir: DATA_DIR,
    // Must be the same instance the tokens above were issued from, otherwise
    // the server holds an empty operator table and rejects every request.
    auth,
    // Demo detections are off by default. Turning this on is an explicit,
    // visible choice so nobody mistakes sample output for a real survivor.
    allowSyntheticDetections: process.env.ALLOW_SYNTHETIC === "1",
  });

  const port = await server.start();

  console.log("");
  console.log("  RescueEye command centre");
  console.log(`  console      http://localhost:${port}/`);
  console.log(`  websocket    ws://localhost:${port}${WS_PATH}`);
  console.log(`  health       http://localhost:${port}/healthz`);
  console.log(`  data dir     ${DATA_DIR}`);
  console.log(`  drone        ${drone.droneId} (simulator)`);
  console.log(`  synthetic CV ${process.env.ALLOW_SYNTHETIC === "1" ? "ENABLED — not real findings" : "disabled"}`);
  console.log("");
  console.log("  Operator tokens (shown once):");
  for (const p of printed) {
    console.log(`    ${p.username.padEnd(10)} ${p.role.padEnd(14)} ${p.token}`);
  }
  console.log("");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[RescueEye] ${signal} received, shutting down`);
    await server.stop().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[RescueEye] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
