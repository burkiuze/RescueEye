# RescueEye — Architecture

This document describes how the system is put together, and — just as
importantly — which parts are not built yet.

---

## 1. Data flow

### Telemetry path

```
SimulatorDroneAdapter | MavlinkDroneAdapter
            │
            │ onTelemetry(Telemetry)   ~10 Hz
            ▼
    RescueEyeServer.onTelemetry
            │
            ├──► TelemetryService.update
            │       ├── alert evaluation (low battery, GPS, link, timeout)
            │       └── broadcast over WebSocket ──► console
            │
            └──► SafetyService.evaluate
                    │
                    ├── emits a SafetyEvent on a threshold transition
                    ├── if no active override → applyFailsafe()
                    │        EmergencyLanding → adapter.requestLand()
                    │        RTHRequested     → adapter.requestRTH()
                    │        MissionAbort     → adapter.abortMission()
                    └── if an override exists → audit the suppression, do nothing
```

### Command path

An operator action travels the opposite way, and always through REST:

```
console ──HTTP POST /api/drone/rth──► authenticate ──► capability check
                                                          │
                                                          ├─ deny → audit + 403
                                                          └─ allow → adapter.requestRTH()
                                                                    │
                                                                    └──► audit
```

Mission control is **not** accepted over the WebSocket. The socket is a
read-only push channel; every action that changes state goes over REST where it
can be authorised and audited per request. The server replies
`unknown_message_type` to `MISSION_CONTROL`.

---

## 2. Layering

```
frontend/          browser console (plain JS, no build step)
      │  HTTPS          WebSocket (read-only push)
──────┼──────────────────────────────────────────────
backend/           HTTP + WS server, auth, safety, missions, events
      │
drone/             DroneAdapter contract
      │
simulator/         a DroneAdapter that needs no hardware
vision/            DetectionModel contract, camera interfaces
```

`DroneAdapter`, `DetectionModel`, `CameraSource`, `MissionStore` and
`EventStore` are interfaces, and the services depend on the interfaces rather
than the implementations. Swapping the simulator for a real MAVLink link does
not touch the server, the safety engine, or the console.

---

## 3. Authentication and authorisation

Three separate concerns:

| Component | Question |
|-----------|----------|
| `AuthService` | Who is making this request? |
| `Authorizer` | Are they allowed to do this? |
| `AuditLog` | What did they do, and what happened? |

- Tokens are `randomBytes(32)`, stored only as salted SHA-256.
- Comparison is constant-time against every operator, with no early exit, so
  neither the token nor which one matched is recoverable from timing.
- No default-allow path: an unknown token is rejected, never treated as an
  anonymous-but-permitted caller.
- Denials are audited. Repeated 403s are the signal you want when someone is
  probing.

The WebSocket authenticates during the HTTP upgrade via `verifyClient`, so an
unauthenticated socket never receives a byte of aircraft state.

### Role capabilities

Defined in `shared/models.ts`:

```ts
observer      mission:read
operator      mission:read, mission:write, mission:control
safetyOfficer mission:read, mission:write, mission:control,
              drone:command, failsafe:override
admin         config:write, account:manage
```

`admin` deliberately does **not** inherit flight authority.

---

## 4. Safety arbitration

`SafetyService` decides *what should happen*. `Authorizer` decides *whether a
human may prevent it*. The server combines them:

```
if override exists for this exact state and not expired:
    audit the suppression
    do not act
else:
    emit event, broadcast state, apply the failsafe
```

An override is granted only to `safetyOfficer`, requires a ≥10 character
reason, is capped at 10 minutes, and applies to one state. Grants, uses and
clears are all audited.

---

## 5. Persistence

Append-only JSONL, one file per store, under `DATA_DIR`:

| File | Contents |
|------|----------|
| `missions.jsonl` | Mission records |
| `events.jsonl` | Event log (immutable) |
| `detections.jsonl` | Detection history |
| `audit.jsonl` | Reserved for audit persistence |

Why JSONL: each record is written and flushed independently, so a crash
mid-sortie truncates at most the final line rather than corrupting the file. On
load a malformed line is skipped and counted (`corruptLines`, exposed on
`/healthz`) instead of discarding the file.

The store interface is identical for the in-memory and on-disk variants, so
tests exercise the same code path without touching the filesystem.

---

## 6. Vision

```
Frame ──► DetectionModel.detect(frame) ──► RawDetection[]
                                              │
                                        non-max suppression
                                              │
                                     Detection (tagged provenance)
```

`DetectionModel` is an interface. `OnnxDetectionModel` takes an
`InferenceRuntime`, supplied by the caller — this keeps the project from being
welded to onnxruntime-web, node, or any vendor's acceleration path.

An `OnnxDetectionModel` with no runtime **refuses to load** rather than silently
returning nothing. A detector that quietly fails during a real search leaves an
operator staring at an empty map.

`SyntheticModel` is the demo generator. It is a `DetectionModel` so the pipeline
can be exercised end to end, but everything it produces is `SYNTHETIC`, and the
server refuses to present synthetic output as a real finding unless explicitly
enabled.

---

## 7. Concurrency and backpressure

| Concern | Approach |
|---------|----------|
| Telemetry rate | Adapter emits ~10 Hz; frames are values, not queued work. |
| Frame buffer | Bounded ring; drops the oldest frame. A dropped frame is better than a stalled pipeline. |
| Detection retention | Capped in `DetectionService` (default 500). |
| Alert repetition | 30 s cooldown per type. |
| Safety events | Emitted on transition, not per frame, with a 30 s cooldown. |
| Event log | Capped in memory; unbounded on disk by design. |
| Audit log | Capped at 10 000 entries. |

---

## 8. What is not implemented

Each item below is a real gap. The interfaces exist; the implementations do not.

### Real UAV link

`MavlinkDroneAdapter` and `MavsdkDroneAdapter` satisfy the contract but their
methods are placeholders — they do not open a socket or speak MAVLink. To
implement:

1. Open a UDP/TCP socket (MAVLink) or gRPC/WebSocket client (MAVSDK).
2. Parse `HEARTBEAT` for state and `SYS_STATUS`/`BATTERY_STATUS` for power.
3. Parse `GLOBAL_POSITION_INT` and `ATTITUDE` into `Telemetry`.
4. Emit `GLOBAL_POSITION_INT` at ~10 Hz, respecting the requested stream rate.
5. Send `SET_MODE`, `MISSION_ITEM_X_*` and `COMMAND_LONG` for commands.
6. Track connection loss from heartbeat timeout, not from socket error alone —
   a silently dead link often looks like an open socket.

`ConnectionManager` already provides reconnect with backoff; it needs a real
adapter behind it.

### Camera pipeline

`FrameBuffer` and the `CameraSource` interfaces exist. Missing: an RTSP client,
a decoder (FFmpeg/GStreamer), and the wiring from frame to `DetectionModel`.

### ONNX inference

`OnnxDetectionModel` is ready for a runtime. Missing: the `InferenceRuntime`
implementation, image preprocessing (resize/normalise), and a trained rescue
detector. `decodeFlatOutput` and `nonMaxSuppression` are written and tested
against synthetic tensors.

### Search-area planning

Waypoint planning is not implemented. The map draws the aircraft, home, track
and detections. Missing: polygon drawing, lawnmower pattern generation,
coverage percentage, per-waypoint progress, and battery-aware route estimates.

### Hardware acceleration

No vendor binding, by intent. `InferenceRuntime` is the seam where
onnxruntime-web with WebGPU, TensorRT, or OpenVINO would be introduced.

---

## 9. Deployment notes

- Bind to `127.0.0.1` unless the network is trusted; use TLS and reverse-proxy
  WebSocket if exposing beyond localhost.
- Provision operator accounts out of band for real use; the startup banner is a
  development convenience.
- `DATA_DIR` should be on durable storage. The event log is the flight record.
- Run under a process supervisor (systemd, PM2) with log rotation.
- `ALLOW_SYNTHETIC` should stay unset outside demos.
