# RescueEye — AI-Powered Search & Rescue UAV Platform

RescueEye is a real-drone search, rescue, and disaster-response platform. It helps rescue teams inspect dangerous areas, detect useful environmental information, monitor telemetry, and coordinate missions from a professional command interface.

The system supports real UAV integration while providing a complete simulator when hardware is unavailable.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Operator Command Center                       │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Map /   │  │  Telemetry   │  │ Detections│  │ Mission   │  │
│  │  Camera  │  │  Dashboard   │  │ Panel     │  │ Controls  │  │
│  └────┬─────┘  └──────┬───────┘  └─────┬────┘  └─────┬─────┘  │
│       │               │                │              │         │
│  ─────┴───────────────┴────────────────┴──────────────┴─────────│
│                    WebSocket (real-time)                        │
│                    REST API (history/config)                    │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────────┐
│                    Backend Server (Node.js)                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ Telemetry    │  │ Mission      │  │ Event / Alert          │ │
│  │ Service      │  │ Service      │  │ Service                │ │
│  └──────┬──────┘  └──────┬───────┘  └───────────┬────────────┘ │
│         │                │                       │              │
│  ┌──────┴────────────────┴───────────────────────┴────────────┐ │
│  │              Safety & Failsafe Controller                  │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────────┐
│               Drone Abstraction Layer                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  DroneAdapter (interface)                                  │  │
│  │  ├── MavlinkDroneAdapter (PX4 / ArduPilot)                │  │
│  │  ├── MavsdkDroneAdapter (MAVSDK protocol)                 │  │
│  │  └── SimulatorDroneAdapter (no hardware needed)           │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────────┐
│               Camera Pipeline                                      │
│  Camera Source → Decoder → Frame Buffer → Vision Worker          │
│  → Detection Service → Overlay Renderer → Operator UI            │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────────┐
│               Computer Vision                                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  DetectionModel (interface)                                │  │
│  │  ├── OnnxDetectionModel (ONNX-compatible, YOLOv8 etc.)   │  │
│  │  └── (replaceable with any model)                         │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

**Drone / Simulator → Telemetry → Backend → Realtime → UI**
1. Drone adapter (MAVLink, MAVSDK, or Simulator) generates telemetry at ~10 Hz
2. TelemetryService validates and checks for alerts
3. Backend broadcasts telemetry via WebSocket to all connected clients
4. REST API provides mission history, configuration, and detection queries

**Camera → Vision → Detection → Map/Overlay/Events**
1. Camera source provides video frames (RTSP, UDP, local, USB)
2. FrameBuffer holds a bounded queue of recent frames (drops old frames)
3. VisionWorker runs detection asynchronously at ~10 Hz
4. DetectionService processes results and notifies listeners
5. Detections are broadcast to UI via WebSocket and overlaid on map/camera

---

## Repository Structure

```
RescueEye/
├── shared/
│   └── models.ts              # Shared TypeScript types & interfaces
├── drone/
│   ├── adapter.ts             # DroneAdapter interface & factory
│   ├── mavlink_adapter.ts     # MAVLink adapter (PX4/ArduPilot)
│   ├── mavsdk_adapter.ts      # MAVSDK adapter
│   └── connection_manager.ts  # Connection lifecycle & reconnect
├── simulator/
│   └── simulator_adapter.ts   # Realistic simulator (same API as real)
├── vision/
│   ├── camera_pipeline.ts     # Camera source → frame buffer → vision
│   └── detection.ts           # ONNX detection model + detection service
├── backend/
│   ├── main.ts                # Server entry point
│   ├── server.ts              # HTTP + WebSocket server
│   ├── telemetry_service.ts   # Telemetry aggregation & alerting
│   ├── mission_service.ts     # Mission lifecycle & event logging
│   ├── safety_service.ts      # Failsafe & safety state machine
│   ├── event_service.ts       # Structured event logging
│   └── connection_manager.ts  # Connection management
├── frontend/
│   ├── index.html             # HTML entry point
│   ├── styles.css             # Aviation-themed dark UI
│   ├── app.ts                 # Main application class
│   └── main.ts                # Entry point
├── tests/
│   └── rescueeye.test.ts      # Comprehensive test suite
├── docs/
│   ├── architecture.md        # This file
│   └── README.md              # Project overview
├── docs/
│   └── architecture.md        # Architecture documentation
├── package.json
├── tsconfig.json
└── README.md
```

---

## Requirements

- Node.js 18+
- npm 9+

---

## Installation

```bash
cd RescueEye
npm install
```

---

## Development Setup

```bash
# Build TypeScript
npm run build

# Run in development mode (simulator)
npm run dev

# Run tests
npm test

# Run with coverage
npm run test:coverage
```

---

## Simulator Mode

RescueEye ships with a built-in simulator that requires no hardware.

The simulator provides realistic telemetry including:
- Changing GPS coordinates
- Altitude and heading
- Battery consumption
- Wind effects
- GPS noise
- Connection state changes

To start in simulator mode:
```bash
npm run dev
```

The simulator is the default mode. To connect to a real drone, configure
a MAVLink or MAVSDK adapter instead.

### Simulator API

```bash
# Set simulator waypoints
curl -X POST http://localhost:8080/api/simulator/waypoints \
  -H "Content-Type: application/json" \
  -d '[{"lat":37.78,"lon":-122.42,"alt":60},{"lat":37.785,"lon":-122.41,"alt":70}]'

# Configure simulator
curl -X POST http://localhost:8080/api/simulator/config \
  -H "Content-Type: application/json" \
  -d '{"speedMps":10,"batteryCapacityPercent":80}'
```

---

## Camera Setup

The camera pipeline supports multiple sources:

| Source    | Class              | Use Case                    |
|-----------|--------------------|-----------------------------|
| RTSP      | `RtspCameraSource` | Network cameras, drones     |
| UDP       | (via RTSP)         | Video streams               |
| Local     | `LocalCameraSource`| Webcam, built-in camera     |
| USB       | (via Local)        | USB cameras                 |
| Recorded  | (custom source)    | Prerecorded test footage    |

The pipeline architecture:
```
Camera Source → Decoder → Frame Buffer (bounded, drops old) → Vision Worker → Overlay → UI
```

---

## Computer Vision Architecture

The detection system is modular and model-agnostic:

```
Frame → DetectionModel.detect(frame) → Detection[]
```

- `DetectionModel` is an interface — swap models without changing the app
- Default implementation uses ONNX-compatible architecture
- Supports YOLOv8, NanoDet, or any ONNX-exported detector
- Designed for edge-device performance
- Bounded frame queue prevents memory growth
- Async processing doesn't block telemetry or UI

Detection output includes:
- `id` — unique detection ID
- `class` — detected object class (person, vehicle, building, debris, smoke, fire, water, etc.)
- `confidence` — detection confidence (0-1)
- `boundingBox` — position and size
- `timestamp` — when detected
- `frameId` — source frame
- `sourceDroneId` — which drone detected it

**Note:** Only generic human presence is detected. No facial recognition, identity, or biometric identification is implemented.

---

## Real UAV Integration Architecture

### Drone Adapter Layer

The `DroneAdapter` interface abstracts the autopilot implementation:

```typescript
interface DroneAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getTelemetry(): Telemetry | null;
  setFlightMode(mode: FlightMode): Promise<void>;
  requestRTH(): Promise<void>;
  requestLand(): Promise<void>;
  // ...
}
```

### Supported Protocols

| Protocol    | Adapter                    | Autopilot Support     |
|-------------|----------------------------|-----------------------|
| MAVLink     | `MavlinkDroneAdapter`      | PX4, ArduPilot        |
| MAVSDK      | `MavsdkDroneAdapter`       | Any MAVSDK-compatible |
| Simulator   | `SimulatorDroneAdapter`    | N/A (simulation)      |

### Connecting a Real Drone

1. Configure the adapter with your drone's connection parameters
2. Use `DroneAdapterFactory` to create the appropriate adapter
3. The rest of the application works identically for real and simulated drones

---

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npx jest tests/rescueeye.test.ts

# Watch mode
npx jest --watch
```

Test coverage includes:
- Telemetry parsing and validation
- Simulator telemetry generation
- Mission state transitions (PLANNED → ACTIVE → COMPLETED/ABORTED)
- Connection loss and reconnect behavior
- Detection model output parsing
- Event logging and filtering
- Warning generation (low battery, GPS degraded, connection lost)
- Safety state transitions
- Frame buffer behavior (bounded queue, drop-oldest)

---

## Production Considerations

### Security
- Use HTTPS/WSS in production
- Authenticate WebSocket connections
- Validate all API inputs
- Rate-limit REST endpoints
- Use environment variables for sensitive configuration

### Performance
- Telemetry: 10 Hz update rate
- Vision: 10 Hz inference rate (async, non-blocking)
- Camera: 20-30 FPS when hardware permits
- Bounded frame buffer prevents memory growth
- Old frames are dropped, never queued indefinitely

### Deployment
- Use PM2 or similar process manager for Node.js
- Configure systemd service for auto-restart
- Set up log rotation
- Monitor system health via `/api/system/health`
- Use reverse proxy (nginx) for WebSocket proxying

### Hardware
- Edge device with GPU acceleration recommended for CV inference
- ONNX Runtime with CUDA/OpenVINO for hardware acceleration
- Minimum 4GB RAM for vision processing
- Network: low-latency link for real-time telemetry

---

## Safety Boundary

RescueEye is strictly a rescue, disaster-response, and situational-awareness platform.

**Not implemented:**
- Weapons or weapon control
- Attack logic or autonomous engagement
- Ammunition or explosive payload control
- Human target selection
- Facial recognition or person identification
- Harmful collision behavior

All computer vision functionality serves rescue, navigation, environmental awareness, or emergency response only.

---

## License

Apache License 2.0
