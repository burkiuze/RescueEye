# RescueEye

AI-assisted search-and-rescue UAV command centre.

RescueEye is a ground-control console for a search-and-rescue drone. It exists
so a rescue team can inspect an unsafe area, watch the aircraft and its
telemetry, record what was seen, and keep the flight record afterwards — from
one screen, with every action attributable to a named operator.

> **Scope.** RescueEye is strictly a rescue, disaster-response and
> situational-awareness platform. It has no weapon, targeting or engagement
> capability of any kind, and it performs no facial recognition or person
> identification. Computer vision is used only to locate things a rescuer needs
> to find: people, vehicles, fire, smoke, water, debris and obstacles.

---

## What actually works today

Read this section before trusting any claim further down.

| Area | State |
|------|-------|
| HTTP server, REST + WebSocket | Working. Binds a real port, serves the console. |
| Authentication (bearer tokens) | Working. Enforced on REST *and* on the WS handshake. |
| Role-based authorisation | Working. Four roles, capability-checked, enforced server-side. |
| Audit trail | Working. Append-only, records denials as well as actions. |
| Safety engine | Working. Evaluated on every telemetry frame, commands the aircraft. |
| Failsafe overrides | Working. Safety-officer-only, reason-required, time-boxed. |
| Mission lifecycle | Working. Legal transitions enforced; illegal ones return 409. |
| Durable persistence | Working. JSONL append-only; survives restart. |
| Simulator (no hardware) | Working. Movement, battery, GPS noise, wind, RTH, land. |
| Console UI | Working. Sign-in, live telemetry, map, detections, event timeline. |
| **Real MAVLink / MAVSDK link** | **Not implemented.** Adapters are scaffolds; see below. |
| **Real camera / video pipeline** | **Not implemented.** Frame buffer and interfaces only. |
| **Real ONNX inference** | **Not implemented.** Pluggable runtime hook, needs a model. |
| **Search-area polygon planning** | **Not implemented.** |

Everything marked *not implemented* is a genuine gap, not a configuration
issue. `DRONE_MODE` refuses anything other than `simulator` rather than
pretending to fly. See [docs/architecture.md](docs/architecture.md) for exactly
what each missing piece needs.

---

## Requirements

- Node.js 18+ (developed against Node 26)
- No database, no build toolchain, no bundler required

## Install

```bash
npm install
npm run build
```

## Run

```bash
npm start
```

The console prints the bound port and one operator token per role:

```
[RescueEye] listening on http://0.0.0.0:8080 (ws /ws)

  Operator tokens (shown once):
    observer   observer       <token>
    operator   operator       <token>
    safety     safetyOfficer  <token>
    admin      admin          <token>
```

Open `http://localhost:8080`, paste a token, sign in.

Tokens are stored only as salted SHA-256 hashes and printed exactly once. If
you lose one, restart the server.

---

## Roles

Authorisation is capability-based, not role-string-based. Adding a role cannot
accidentally widen someone's permissions.

| Role | Can |
|------|-----|
| `observer` | Read missions, telemetry, detections, events. Nothing else. |
| `operator` | Create and run missions: start, pause, abort. |
| `safetyOfficer` | Everything `operator` can, **plus** command the aircraft (RTH, land) and override a failsafe. |
| `admin` | Manage accounts and configuration. **Not** a flight authority. |

Two deliberate separations:

- An **operator** can run a mission but cannot move the aircraft directly.
- An **admin** cannot fly anything. Configuring the system and commanding it
  are different responsibilities and are not combined.

### Failsafe overrides

Suppressing an automated safety action is the most dangerous thing an operator
can do, so it is fenced in:

- only `safetyOfficer`
- a written reason of at least 10 characters is required
- time-boxed (default 2 minutes, max 10)
- scoped to one safety state
- every grant and every use is written to the audit log

---

## Safety

`SafetyService` runs on every telemetry frame. When a threshold is crossed it
emits an event and, unless a valid override exists, **commands the aircraft**.

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Critical battery | ≤ 5 % | Emergency landing |
| Low battery | ≤ 20 % | Return to home |
| Link lost | connection ≠ CONNECTED | Abort mission |
| GPS degraded | no fix, or < 4 satellites | Warning |
| Geofence | > 5000 m from home | Warning |
| High wind | ground speed > 15 m/s | Warning |

Events fire on the **transition** into a condition, not on every frame that still
satisfies it. Without that, a 10 Hz stream with a pack at 3 % would emit ~10
emergency-landing commands per second and bury the operator in noise at exactly
the moment they most need to read the screen.

Priority order, when these conflict:

1. An unauthenticated request never reaches an aircraft command.
2. A failsafe fires unless an authorised, unexpired override exists for that
   exact state.
3. Mission progress never outranks either of the above.

---

## Detections and `provenance`

Every detection carries where it came from:

| Value | Meaning |
|-------|---------|
| `MODEL` | Produced by a loaded inference model on real imagery. |
| `SYNTHETIC` | Produced by the demo generator. **Not actionable.** |
| `OPERATOR` | Manually marked by a human. |

This is enforced, not advisory:

- synthetic generation is **off by default** (`ALLOW_SYNTHETIC=1` to enable);
- the server downgrades output it cannot vouch for to `SYNTHETIC`;
- the console renders simulated findings with a visible `SIMULATED` tag and a
  standing warning that they are not people;
- `/api/detections?real=true` filters them out entirely.

A rescuer must never be able to direct a team to a fabricated detection, or
call off a search for a survivor who is still there.

---

## Simulator

Runs with no hardware, through the same `DroneAdapter` interface a real drone
uses — the rest of the system cannot tell the difference.

Modelled: position and heading, altitude, battery drain (~20 min pack), GPS
noise, wind push, telemetry rate, and RTH/land behaviour. Configured via env:

| Variable | Default |
|----------|---------|
| `DRONE_MODE` | `simulator` (only value implemented) |
| `PORT` / `HOST` | `8080` / `0.0.0.0` |
| `DATA_DIR` | `./data` |
| `START_LAT` / `START_LON` / `START_ALT` | `37.7749` / `-122.4194` / `50` |
| `SPEED_MPS` | `5` |
| `BATTERY_DRAIN` | `100/1200` (% per second) |
| `CONN_LOSS_CHANCE` | `0.0005` |
| `ALLOW_SYNTHETIC` | unset (off) |

---

## Tests

```bash
npm run build
npm test
```

119 tests across three suites:

- **unit** — roles and capabilities, auth, overrides and expiry, audit,
  safety transitions, mission state machine, persistence and crash recovery,
  detection provenance, NMS, simulator behaviour.
- **integration** — starts a real listener and speaks real HTTP and WebSocket:
  port binding, auth on both transports, per-role authorisation, route
  parameter matching, illegal mission transitions, override policy, WebSocket
  handshake rejection, persistence across restart.
- **entrypoint** — the startup bootstrap wiring, which is where the tokens and
  the server's `AuthService` must be the same object.

---

## Repository layout

```
backend/
  main.ts            entry point: config, seeding, listener
  server.ts          HTTP + WS, routing, auth, safety arbitration
  auth_service.ts    tokens, capabilities, audit, override ledger
  persistence.ts     append-only JSONL stores
  safety_service.ts  threshold evaluation and failsafe actions
  telemetry_service.ts  telemetry state, alerting, timeouts
  event_service.ts   structured, filterable event log
  mission_service.ts  mission state machine and stores
drone/
  adapter.ts         DroneAdapter contract and re-exports
  mavlink_adapter.ts   scaffold
  mavsdk_adapter.ts    scaffold
  connection_manager.ts
simulator/
  simulator_adapter.ts
vision/
  detection.ts       DetectionModel, ONNX hook, SyntheticModel, NMS
  camera_pipeline.ts FrameBuffer and camera interfaces
shared/
  models.ts          types, roles, capabilities
frontend/
  index.html  app.js  styles.css
tests/
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — data flow, layering, and what
  each unimplemented component requires.

## License

Apache 2.0
