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
| **Geofence enforcement** | **Advisory only.** Warns; does not command a return. |
| **Vision + mission services at runtime** | **Not wired.** `vision/` and `backend/mission_service.ts` are tested but not imported by the server. |
| **Audit persistence** | **In-memory only.** Capped at 10 000 entries, lost on restart. |

Everything marked *not implemented* is a genuine gap, not a configuration
issue. `DRONE_MODE` refuses anything other than `simulator` rather than
pretending to fly. See [docs/architecture.md](docs/architecture.md) §11 for the
full component-by-component status table.

### Known safety limitations

- **Geofence is advisory.** It warns; it will not stop the aircraft leaving the area.
- **Wind is a proxy.** The monitor compares ground speed against a wind threshold,
  so a strong wind while hovering reads as zero.
- **Duplicated thresholds.** `telemetry_service.ts` and `safety_service.ts` each define
  their own battery and satellite limits; they can drift.
- **Safety has no process isolation.** It is a synchronous call in the same event
  loop as everything else; a blocking call anywhere stalls the failsafe.
- **Audit log is in-memory.** A restart erases who-did-what.

The full single-point-of-failure register, and the assumptions that are believed
but not yet proven, are in
[docs/architecture.md sections 15-16](docs/architecture.md).

### Health reporting

`/healthz` returns a **derived** verdict across ten subsystems, never a hardcoded
`ok`:

```
NOMINAL > UNKNOWN > DEGRADED > CRITICAL > OFFLINE   (worst wins)
```

A subsystem that has not been measured reports `UNKNOWN`, and `UNKNOWN`
propagates to the aggregate. With no camera source and no vision model wired --
the shipped configuration -- the console reports `UNKNOWN`, because that is the
honest answer. Treating it as nominal would be false reassurance during a
search.

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

150 tests across four suites:

- **unit** — roles and capabilities, auth, overrides and expiry, audit,
  safety transitions, mission state machine, persistence and crash recovery,
  detection provenance, NMS, simulator behaviour.
- **integration** — starts a real listener and speaks real HTTP and WebSocket:
  port binding, auth on both transports, per-role authorisation, route
  parameter matching, illegal mission transitions, override policy, WebSocket
  handshake rejection, persistence across restart.
- **entrypoint** — the startup bootstrap wiring, which is where the tokens and
  the server's `AuthService` must be the same object.
- **health** — system-health aggregation, in particular that an unmeasured
  subsystem reports `UNKNOWN` and never folds into a healthy verdict.

Documentation diagrams are checked too:

```bash
node scripts/check-mermaid.js
```

Parses every Mermaid block in `docs/architecture.md` and reports undeclared
nodes and unbalanced braces, so a diagram cannot silently rot into something
that looks authoritative and renders as an error.

---

## Architecture

The platform is documented as seven cooperating systems rather than a dashboard
with a data feed:

| System | Responsibility |
|--------|----------------|
| **Rescue UAV / onboard** | Flight core, navigation and attitude state, sensor fusion, telemetry publication |
| **Vision & AI perception** | Frame pipeline, ONNX detection, confidence filtering, NMS, provenance gating |
| **Mission intelligence** | Search area, coverage planning, waypoints, lifecycle state machine |
| **Safety / failsafe** | Threshold evaluation, transition detection, arbitration, failsafe dispatch |
| **Ground control centre** | Sign-in, live map, telemetry, detections, timeline, role-gated controls |
| **Audit / flight record** | Mission events, safety events, security audit, append-only persistence |
| **Digital twin** | Simulator satisfying the same `DroneAdapter` contract as a real aircraft |

### System map

A single-page visual map of the whole platform — zones, components, status, and
the file that backs each one:

**[docs/architecture-map.html](docs/architecture-map.html)**

Regenerate with `npm run build:map`. The generator verifies every file path it
cites, so the map cannot drift into pointing at files that no longer exist.

### Master diagram

The full system architecture — 194 components across 14 subgraphs — is in
[`docs/architecture.md`](docs/architecture.md), together with:

- search and rescue mission flow
- vision and detection architecture
- safety and failsafe architecture
- human safety authority (override path)
- command and authorisation pipeline
- telemetry and communication architecture
- ground control architecture
- simulator / real UAV abstraction
- event, audit and persistence architecture
- an implementation-status table mapping every component to its source file

### Two things to know before reading the architecture

**`vision/` and `backend/mission_service.ts` are implemented and unit-tested but
not imported by the server or the entry point.** The running console uses the
server's own mission state machine and its own detection recorder. They are
marked `[UNWIRED]` throughout the architecture document and are not drawn as
active in the master diagram.

**`mavlink_adapter.ts` and `mavsdk_adapter.ts` satisfy the `DroneAdapter`
interface, but their method bodies are placeholders.** Neither opens a socket.
They would not work against a real aircraft.

### Command path

No browser-to-aircraft path exists that skips the backend:

```
console → REST → authenticate → authorise → validate → safety arbitration
        → command gateway → DroneAdapter → aircraft
```

The WebSocket is a **read-only push channel**. Aircraft-changing commands are
refused over it (`unknown_message_type`) so that every state change is
authorised and audited per request.

### The abstraction that matters

```
REAL UAV ────┐
             ├──▶ DroneAdapter ──▶ telemetry · missions · safety · UI
SIMULATOR ───┘
```

Everything above the interface is identical whether the aircraft is real or
simulated. `DRONE_MODE` refuses any value other than `simulator` rather than
pretending to fly.

---

## Repository layout

```
backend/
  main.ts               entry point: config, operator seeding, listener
  server.ts             HTTP + WS, routing, auth, safety arbitration, stores
  auth_service.ts       tokens, capabilities, audit log, override ledger
  persistence.ts        append-only JSONL stores with crash recovery
  safety_service.ts     threshold evaluation, transition detection, failsafes
  telemetry_service.ts  telemetry state, alerting, timeouts
  event_service.ts      structured, filterable event log
  mission_service.ts    mission state machine + stores  [UNWIRED]
drone/
  adapter.ts            DroneAdapter contract and re-exports
  mavlink_adapter.ts    MAVLink scaffold                [PLANNED]
  mavsdk_adapter.ts     MAVSDK scaffold                 [PLANNED]
  connection_manager.ts reconnect policy
simulator/
  simulator_adapter.ts  hardware-free aircraft          [IMPLEMENTED]
vision/
  detection.ts          DetectionModel, ONNX hook, SyntheticModel, NMS  [UNWIRED]
  camera_pipeline.ts    FrameBuffer + camera interfaces [UNWIRED]
shared/
  models.ts             types, roles, capabilities, provenance
frontend/
  index.html app.js styles.css    console, no build step
tests/
  unit.test.ts          3 suites: unit, integration, entry point
  integration.test.ts
  entrypoint.test.ts
scripts/
  build.js              TypeScript build
  check-mermaid.js      validates every diagram in docs/architecture.md
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — data flow, layering, and what
  each unimplemented component requires.

## License

Apache 2.0
