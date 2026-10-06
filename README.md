# RescueEye

AI-Powered Search & Rescue UAV Platform

RescueEye is a real-drone search, rescue, and disaster-response platform. It helps rescue teams inspect dangerous areas, detect useful environmental information, monitor telemetry, and coordinate missions from a professional command interface.

The system supports real UAV integration while providing a complete simulator when hardware is unavailable.

## Quick Start

```bash
cd RescueEye
npm install
npm run dev
```

Open http://localhost:8080 in your browser.

## Features

- **Drone Connectivity** — MAVLink, MAVSDK, and Simulator adapters
- **Real-time Telemetry** — 10 Hz telemetry with alerting
- **Search & Rescue Missions** — Waypoint planning, polygon search areas
- **Computer Vision** — ONNX-compatible detection (person, vehicle, smoke, fire, debris, etc.)
- **Camera Pipeline** — RTSP, UDP, local camera support
- **Interactive Map** — Live UAV position, heading, detections, flight path
- **Command Center UI** — Professional aviation/emergency-response interface
- **Safety & Failsafe** — RTH, low battery, GPS degradation, connection loss handling
- **Event Timeline** — Structured mission event logging with filtering
- **Full Simulator** — Realistic simulated drone with no hardware required

## Architecture

```
Drone/Simulator → Drone Adapter → Telemetry → Backend (WebSocket + REST) → Operator UI
Camera → Video Pipeline → Vision Worker → Detection Service → Map/Overlay/Events
```

See [docs/architecture.md](docs/architecture.md) for the complete architecture documentation.

## Repository Structure

```
RescueEye/
├── shared/              # Shared data models & types
├── drone/               # Drone abstraction layer & adapters
├── simulator/           # Simulator drone adapter
├── vision/              # Camera pipeline & computer vision
├── backend/             # Server, services, API
├── frontend/            # Command center UI
├── tests/               # Test suite
├── docs/                # Documentation
├── package.json
└── tsconfig.json
```

## Requirements

- Node.js 18+
- npm 9+

## Development

```bash
npm install
npm run build       # TypeScript compilation
npm run dev         # Start with simulator
npm test            # Run test suite
```

## Simulator Mode

The simulator is the default mode — no hardware required. It provides:
- Realistic GPS movement
- Battery consumption
- Wind effects
- GPS noise
- Connection state changes
- Waypoint navigation

## Real UAV Integration

To connect a real drone, configure a MAVLink or MAVSDK adapter:

```typescript
import { MavlinkDroneAdapter } from "./drone/mavlink_adapter";

const adapter = new MavlinkDroneAdapter("drone-001", {
  udpPort: 14550,
  systemId: 1,
  componentId: 1,
});
```

## Computer Vision

The detection system uses an ONNX-compatible architecture:
- Supports YOLOv8, NanoDet, or any ONNX-exported model
- Detects: person, vehicle, building, debris, smoke, fire, water, trees, obstacles
- Only generic human presence detection (no facial recognition or identification)
- Async processing — doesn't block telemetry or UI
- Bounded frame queue — old frames dropped to prevent memory growth

## Safety

RescueEye is a rescue and disaster-response platform only. It does not implement weapons, attack logic, or any functionality intended to harm people or property.

## License

Apache License 2.0
