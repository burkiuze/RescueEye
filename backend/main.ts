// RescueEye — Server Entry Point
// Starts the HTTP + WebSocket server with simulator mode by default.

import path from "path";
import http from "http";
import { RescueEyeServer } from "./server";
import { SimulatorDroneAdapter } from "../simulator/simulator_adapter";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const WS_PATH = process.env.WS_PATH ?? "/ws";

// Create simulator adapter (default — works without hardware)
const simulator = new SimulatorDroneAdapter("sim-drone-001", {
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
});

// Create and start server
const server = new RescueEyeServer({
  port: PORT,
  wsPath: WS_PATH,
  droneAdapter: simulator,
  simulatorConfig: {
    startLatitude: 37.7749,
    startLongitude: -122.4194,
    startAltitude: 50,
  },
});

// Serve static frontend files
const frontendDir = path.join(process.cwd(), "frontend");
const httpServer = server.getHttpServer();

httpServer.on("request", (req, res) => {
  const url = req.url ?? "/";

  // Serve frontend static files
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    // In production, serve the actual HTML file
    res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>RescueEye</title></head><body><div id="app"></div><script>/* Frontend would be served as bundled JS */</script></body></html>`);
    return;
  }

  if (url === "/styles.css") {
    res.writeHead(200, { "Content-Type": "text/css" });
    res.end("");
    return;
  }

  // API routes handled by RescueEyeServer
  // (The server's router handles /api/* paths)
});

server.start().then(() => {
  console.log(`RescueEye server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}${WS_PATH}`);
  console.log(`Simulator mode: ACTIVE`);
  console.log(`Dashboard: http://localhost:${PORT}`);
}).catch((err) => {
  console.error("Failed to start RescueEye server:", err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down RescueEye...");
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
