// RescueEye — architecture map generator (HTML/CSS).
//
// The target environment is an embedded webview that does not render SVG, so
// the map is emitted as pure HTML/CSS: absolutely positioned node cards over a
// grid of swim-lane zones, with connector lines drawn as CSS borders and
// labels as positioned spans.
//
// Every node carries the source file that backs it, and a status of
// implemented / partial / planned / unwired. A node whose file column is
// "—" is not implemented; that is the point of the map.
//
// Run:  node scripts/build-map.js
// Out:  docs/architecture-map.html

const fs = require("node:fs");
const path = require("node:path");

const S = {
  IMPL: "implemented",
  PARTIAL: "partial",
  PLANNED: "planned",
  UNWIRED: "unwired",
};

// ── Nodes ──────────────────────────────────────────────────────────────
// lane: zone id. row/col place the card inside its zone.

const NODES = [
  // Zone A — onboard sensors
  { id: "rf", lane: "A", row: 0, col: 0, title: "RF / Telemetry", sub: "connectionState", status: S.IMPL, file: "shared/models.ts" },
  { id: "gnss", lane: "A", row: 0, col: 1, title: "GNSS", sub: "fix · satellites", status: S.PARTIAL, file: "simulator/simulator_adapter.ts" },
  { id: "imu", lane: "A", row: 0, col: 2, title: "IMU", sub: "accel · gyro", status: S.PLANNED, file: "—" },
  { id: "baro", lane: "A", row: 0, col: 3, title: "Barometer", sub: "altitude", status: S.PLANNED, file: "—" },
  { id: "comp", lane: "A", row: 0, col: 4, title: "Compass", sub: "heading", status: S.PARTIAL, file: "simulator/simulator_adapter.ts" },

  // Zone B — vision
  { id: "camsrc", lane: "B", row: 0, col: 0, title: "Camera Source", sub: "RTSP · local · file", status: S.PLANNED, file: "vision/camera_pipeline.ts (stub)" },
  { id: "framebuf", lane: "B", row: 0, col: 1, title: "Frame Buffer", sub: "bounded · drop-oldest", status: S.IMPL, file: "vision/camera_pipeline.ts", note: "tested, not wired" },
  { id: "preproc", lane: "B", row: 0, col: 2, title: "Preprocessing", sub: "resize · normalise", status: S.PLANNED, file: "—" },
  { id: "infer", lane: "B", row: 0, col: 3, title: "Inference Runtime", sub: "ONNX · pluggable", status: S.PLANNED, file: "vision/detection.ts (interface only)" },
  { id: "model", lane: "B", row: 0, col: 4, title: "Detection Model", sub: "DetectionModel", status: S.IMPL, file: "vision/detection.ts", note: "NMS + decode tested" },
  { id: "nms", lane: "B", row: 1, col: 0, title: "Confidence Filter + NMS", sub: "IoU 0.45", status: S.IMPL, file: "vision/detection.ts" },
  { id: "prov", lane: "B", row: 1, col: 1, title: "Provenance Gate", sub: "MODEL · OPERATOR · SYNTHETIC", status: S.IMPL, file: "backend/server.ts", hub: true, note: "synthetic never looks real" },
  { id: "geoloc", lane: "B", row: 1, col: 2, title: "Geolocation", sub: "pixel → coordinate", status: S.PLANNED, file: "—" },

  // Zone C — digital twin
  { id: "fault", lane: "C", row: 0, col: 0, title: "Fault Injection", sub: "battery · GPS · link · clock", status: S.IMPL, file: "simulator/simulator_adapter.ts", note: "makes safety testable" },
  { id: "phys", lane: "C", row: 0, col: 1, title: "Physics Models", sub: "position · heading · altitude", status: S.IMPL, file: "simulator/simulator_adapter.ts" },
  { id: "batt", lane: "C", row: 0, col: 2, title: "Battery Model", sub: "≈20 min pack", status: S.IMPL, file: "simulator/simulator_adapter.ts" },
  { id: "wind", lane: "C", row: 0, col: 3, title: "Wind + GPS Noise", sub: "push · jitter", status: S.IMPL, file: "simulator/simulator_adapter.ts" },
  { id: "rthland", lane: "C", row: 0, col: 4, title: "RTH / Landing", sub: "terminates on arrival", status: S.IMPL, file: "simulator/simulator_adapter.ts" },
  { id: "simeng", lane: "C", row: 1, col: 2, title: "Simulation Engine", sub: "tick · 10 Hz", status: S.IMPL, file: "simulator/simulator_adapter.ts" },

  // Zone D — adapter seam
  { id: "simad", lane: "D", row: 0, col: 0, title: "SimulatorDroneAdapter", sub: "no hardware needed", status: S.IMPL, file: "simulator/simulator_adapter.ts" },
  { id: "mav", lane: "D", row: 0, col: 1, title: "MavlinkDroneAdapter", sub: "PX4 · ArduPilot", status: S.PLANNED, file: "drone/mavlink_adapter.ts", note: "no socket" },
  { id: "sdk", lane: "D", row: 0, col: 2, title: "MavsdkDroneAdapter", sub: "MAVSDK", status: S.PLANNED, file: "drone/mavsdk_adapter.ts", note: "no client" },
  { id: "seam", lane: "D", row: 1, col: 1, title: "DroneAdapter", sub: "the one seam everything shares", status: S.IMPL, file: "shared/models.ts", diamond: true },

  // Zone E — telemetry + safety
  { id: "tlmrecv", lane: "E", row: 0, col: 0, title: "Telemetry Receiver", sub: "validate · hold state", status: S.IMPL, file: "backend/server.ts" },
  { id: "tlsvc", lane: "E", row: 0, col: 1, title: "TelemetryService", sub: "latest frame · alerts", status: S.IMPL, file: "backend/telemetry_service.ts" },
  { id: "monitors", lane: "E", row: 1, col: 0, title: "Safety Monitors", sub: "battery · gps · link · geo · wind", status: S.PARTIAL, file: "backend/safety_service.ts", note: "geofence warns only" },
  { id: "safety", lane: "E", row: 1, col: 1, title: "SafetyService.evaluate", sub: "every single frame", status: S.IMPL, file: "backend/safety_service.ts", diamond: true, hub: true },
  { id: "trans", lane: "E", row: 1, col: 2, title: "Transition Detector", sub: "state change + 30 s", status: S.IMPL, file: "backend/safety_service.ts" },
  { id: "arb", lane: "E", row: 1, col: 3, title: "Failsafe + Arbitration", sub: "override ledger", status: S.IMPL, file: "backend/server.ts", diamond: true },
  { id: "dispatch", lane: "E", row: 1, col: 4, title: "Drone Command Dispatch", sub: "RTH · land · abort", status: S.IMPL, file: "backend/server.ts" },

  // Zone F — security + command
  { id: "console", lane: "F", row: 0, col: 0, title: "Ground Console", sub: "no build step", status: S.IMPL, file: "frontend/app.js" },
  { id: "auth", lane: "F", row: 0, col: 1, title: "Authentication", sub: "bearer · constant-time", status: S.IMPL, file: "backend/auth_service.ts" },
  { id: "authz", lane: "F", row: 0, col: 2, title: "Capability Authorization", sub: "role → capability", status: S.IMPL, file: "backend/auth_service.ts", diamond: true, note: "admin cannot fly" },
  { id: "valid", lane: "F", row: 0, col: 3, title: "Input Validation", sub: "256 KB cap · schema", status: S.IMPL, file: "backend/server.ts" },
  { id: "gateway", lane: "F", row: 0, col: 4, title: "Drone Command Gateway", sub: "REST only", status: S.IMPL, file: "backend/server.ts" },
  { id: "audit", lane: "F", row: 1, col: 1, title: "AuditLog", sub: "allowed + denied", status: S.IMPL, file: "backend/auth_service.ts", note: "in-memory only" },

  // Zone G — mission
  { id: "area", lane: "G", row: 0, col: 0, title: "Search Area", sub: "polygon", status: S.PLANNED, file: "—" },
  { id: "cover", lane: "G", row: 0, col: 1, title: "Coverage + Waypoint Planner", sub: "lawnmower pattern", status: S.PLANNED, file: "—" },
  { id: "mstatem", lane: "G", row: 0, col: 2, title: "Mission State Machine", sub: "PLANNED→ACTIVE→…→FAILED", status: S.IMPL, file: "backend/server.ts", note: "illegal → 409" },
  { id: "prog", lane: "G", row: 0, col: 3, title: "Mission Progress", sub: "estimates · abort", status: S.PARTIAL, file: "backend/server.ts", note: "progress only, no coverage" },

  // Zone H — ground control
  { id: "gate", lane: "H", row: 0, col: 0, title: "Sign-in Gate", sub: "role-gated controls", status: S.IMPL, file: "frontend/index.html" },
  { id: "tpanel", lane: "H", row: 0, col: 1, title: "Telemetry Panel", sub: "ALT · BAT · GPS · LINK", status: S.IMPL, file: "frontend/app.js" },
  { id: "map", lane: "H", row: 0, col: 2, title: "Live Map", sub: "track · detections", status: S.IMPL, file: "frontend/app.js" },
  { id: "review", lane: "H", row: 0, col: 3, title: "Detection Review", sub: "SIMULATED tag", status: S.IMPL, file: "frontend/app.js" },
  { id: "timeline", lane: "H", row: 0, col: 4, title: "Event Timeline", sub: "300-entry bound", status: S.IMPL, file: "frontend/app.js" },
  { id: "ws", lane: "H", row: 1, col: 2, title: "WebSocket", sub: "read-only push", status: S.IMPL, file: "backend/server.ts", note: "commands refused" },

  // Zone I — health + persistence
  { id: "store", lane: "I", row: 0, col: 0, title: "Event / Mission / Detection Store", sub: "JSONL append-only", status: S.IMPL, file: "backend/persistence.ts" },
  { id: "persist", lane: "I", row: 0, col: 1, title: "Crash-tolerant Load", sub: "skip bad line, count it", status: S.IMPL, file: "backend/persistence.ts" },
  { id: "health", lane: "I", row: 0, col: 2, title: "SystemHealthManager", sub: "worst-of · UNKNOWN ≠ NOMINAL", status: S.IMPL, file: "backend/health_manager.ts", diamond: true, hub: true },
  { id: "hz", lane: "I", row: 0, col: 3, title: "/healthz", sub: "derived verdict", status: S.IMPL, file: "backend/server.ts" },
];

// Edges. Drawn as labelled flow strips between zones rather than routed lines:
// a routed SVG would be prettier but unreadable at this density.
const FLOWS = [
  { from: "SENSORS / ONBOARD", to: "TELEMETRY & SAFETY", label: "telemetry frames ~10 Hz" },
  { from: "DRONE ADAPTER SEAM", to: "TELEMETRY & SAFETY", label: "adapter callback" },
  { from: "TELEMETRY & SAFETY", to: "DRONE ADAPTER SEAM", label: "RTH · land · abort", danger: true },
  { from: "AUTHORIZATION & COMMAND", to: "DRONE ADAPTER SEAM", label: "authorised commands", danger: true },
  { from: "DIGITAL TWIN / SIMULATOR", to: "DRONE ADAPTER SEAM", label: "substitutes for the aircraft" },
  { from: "TELEMETRY & SAFETY", to: "EVENTS & PERSISTENCE", label: "failsafe decisions", danger: true },
  { from: "MISSION INTELLIGENCE", to: "DRONE ADAPTER SEAM", label: "abort on link loss", danger: true },
  { from: "VISION & AI PERCEPTION", to: "GROUND CONTROL CENTRE", label: "candidate findings" },
  { from: "TELEMETRY & SAFETY", to: "GROUND CONTROL CENTRE", label: "WebSocket push, read-only" },
  { from: "GROUND CONTROL CENTRE", to: "AUTHORIZATION & COMMAND", label: "REST commands" },
  { from: "every zone", to: "EVENTS & PERSISTENCE", label: "append-only flight record" },
];

const LANE_LABELS = {
  A: "SENSORS / ONBOARD",
  B: "VISION & AI PERCEPTION",
  C: "DIGITAL TWIN / SIMULATOR",
  D: "DRONE ADAPTER SEAM",
  E: "TELEMETRY & SAFETY",
  F: "AUTHORIZATION & COMMAND",
  G: "MISSION INTELLIGENCE",
  H: "GROUND CONTROL CENTRE",
  I: "EVENTS & PERSISTENCE",
};

// Zonal order. Safety sits directly above authorization because the ordering
// matters operationally: nothing may command the aircraft except through both.
const LANE_ORDER = ["C", "D", "A", "E", "F", "G", "B", "H", "I"];

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function nodeCard(n) {
  const cls = ["node", n.status];
  if (n.hub) cls.push("hub");
  if (n.diamond) cls.push("diamond");
  const note = n.note ? `<span class="note">${esc(n.note)}</span>` : "";
  return `<div class="${cls.join(" ")}" data-status="${n.status}">
    <span class="stripe"></span>
    <div class="body">
      <div class="t">${esc(n.title)}</div>
      <div class="s">${esc(n.sub)}</div>
      <div class="f">${esc(n.file)}</div>
      ${note}
    </div>
  </div>`;
}

const counts = NODES.reduce((a, n) => ((a[n.status] = (a[n.status] || 0) + 1), a), {});

const lanes = LANE_ORDER.map((id) => {
  const nodes = NODES.filter((n) => n.lane === id);
  return `<section class="lane" id="lane-${id}">
    <header class="lane-head"><span class="lane-id">${id}</span> ${esc(LANE_LABELS[id])}</header>
    <div class="lane-body">${nodes.map(nodeCard).join("")}</div>
  </section>`;
}).join("\n");

const flows = FLOWS.map((f) => {
  const cls = f.danger ? "flow danger" : "flow";
  return `<div class="${cls}"><span class="arrow">→</span> ${esc(f.from)} ${esc(f.label)} ${esc(f.to)}</div>`;
}).join("\n");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RescueEye — System Map</title>
<style>
  :root{
    --bg:#080a0e; --lane:#0f1218; --lane-line:#1b212b;
    --card:#161b23; --card-line:#242c37;
    --ink:#e2e8f0; --dim:#7c8798; --faint:#4d5765;
    --impl:#22d37a; --partial:#f0a417; --planned:#5d6875; --unwired:#b57bff;
    --danger:#ff4d4d;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);
       font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
       padding:22px 20px 40px}

  header.page{margin-bottom:18px}
  h1{font-size:22px;font-weight:700;letter-spacing:1.5px}
  .sub{color:var(--dim);font-size:12.5px;margin-top:5px;max-width:900px}

  .legend{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 22px}
  .chip{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;
        border:1px solid var(--card-line);border-radius:999px;background:var(--card);
        font:600 11px/1 ui-monospace,monospace;letter-spacing:.6px;cursor:pointer;
        color:var(--ink);user-select:none}
  .chip i{width:9px;height:9px;border-radius:2px;display:inline-block}
  .chip small{color:var(--dim);font-weight:400;letter-spacing:0}
  .chip[aria-pressed="false"]{opacity:.34}
  .chip.impl i{background:var(--impl)} .chip.impl[aria-pressed="true"]{border-color:var(--impl)}
  .chip.partial i{background:var(--partial)} .chip.partial[aria-pressed="true"]{border-color:var(--partial)}
  .chip.planned i{background:var(--planned)} .chip.planned[aria-pressed="true"]{border-color:var(--planned)}
  .chip.unwired i{background:var(--unwired)} .chip.unwired[aria-pressed="true"]{border-color:var(--unwired)}

  .lane{background:var(--lane);border:1px solid var(--lane-line);border-radius:10px;
        margin-bottom:10px;overflow:hidden}
  .lane-head{font:700 10.5px/1 ui-monospace,monospace;letter-spacing:1.8px;color:var(--dim);
            padding:11px 14px;border-bottom:1px solid var(--lane-line);background:#0c0f14;
            display:flex;align-items:center;gap:9px}
  .lane-id{display:inline-grid;place-items:center;width:19px;height:19px;border-radius:4px;
          background:#161c26;border:1px solid #2a3341;color:var(--ink);font-size:10px}
  .lane-body{display:flex;flex-wrap:wrap;gap:10px;padding:12px}

  .node{position:relative;flex:1 1 190px;min-width:190px;max-width:280px;
        background:var(--card);border:1px solid var(--card-line);border-radius:7px;
        overflow:hidden}
  .node .stripe{position:absolute;left:0;top:0;bottom:0;width:3px}
  .node .body{padding:9px 11px 9px 14px}
  .node .t{font-size:12.5px;font-weight:650;line-height:1.25}
  .node .s{font-size:10.5px;color:var(--dim);margin-top:2px}
  .node .f{font:9.5px/1.3 ui-monospace,monospace;color:var(--faint);margin-top:5px;
           word-break:break-word}
  .node .note{display:inline-block;margin-top:6px;padding:2px 6px;border-radius:3px;
              background:#1b212b;color:var(--partial);font:9px/1.4 ui-monospace,monospace}

  .node.implemented .stripe{background:var(--impl)}
  .node.partial     .stripe{background:var(--partial)}
  .node.planned     .stripe{background:var(--planned)}
  .node.unwired     .stripe{background:var(--unwired)}
  .node.implemented{border-left:1px solid rgba(34,211,122,.4)}
  .node.partial    {border-left:1px solid rgba(240,164,23,.4)}
  .node.planned    {border-left:1px solid rgba(93,104,117,.4);opacity:.82}
  .node.unwired    {border-left:1px solid rgba(181,123,255,.4)}

  /* Hub and decision-point nodes read as the joints of the system. */
  .node.hub{border-color:#4a3030;background:#1a1418}
  .node.hub .t{color:#ffd9d9}
  .node.hub::after{content:"";position:absolute;inset:-1px;border-radius:7px;
                   pointer-events:none;box-shadow:inset 0 0 0 1px rgba(255,77,77,.35)}
  .node.diamond{border-style:dashed;border-color:#3d4856}
  .node.diamond .t::before{content:"◆ ";color:var(--dim);font-size:9px}

  /* The safety lane is the reason the whole system exists; give it weight. */
  #lane-E{border-color:#3a2020}
  #lane-E .lane-head{color:#ff9c9c;background:#150d0d}

  .flows{margin-top:22px;background:var(--lane);border:1px solid var(--lane-line);
         border-radius:10px;padding:14px}
  .flows h2{font:700 10.5px/1 ui-monospace,monospace;letter-spacing:1.8px;color:var(--dim);
            margin-bottom:11px}
  .flow{display:flex;align-items:center;gap:9px;padding:6px 10px;border-radius:5px;
        font:11.5px/1.4 ui-monospace,monospace;color:var(--dim);margin-bottom:3px}
  .flow .arrow{color:var(--faint)}
  .flow.danger{color:var(--danger);background:rgba(255,77,77,.07)}

  footer{margin-top:22px;color:var(--faint);font:11px/1.6 ui-monospace,monospace}
  footer code{color:var(--dim)}

  /* Filtering dims a status rather than removing it, so the shape of the
     system stays legible while you compare states. */
  body.hide-implemented .node[data-status=implemented]{opacity:.13}
  body.hide-partial     .node[data-status=partial]{opacity:.13}
  body.hide-planned     .node[data-status=planned]{opacity:.13}
  body.hide-unwired     .node[data-status=unwired]{opacity:.13}

  @media (max-width:640px){
    body{padding:14px 12px 30px}
    .node{flex-basis:100%;max-width:none}
  }
</style>
</head>
<body>

<header class="page">
  <h1>RESCUEEYE — SYSTEM MAP</h1>
  <p class="sub">
    Search &amp; rescue UAV platform. Onboard perception, mission intelligence,
    safety/failsafe, secure ground control, flight record, and a digital twin.
    Every card names the file that backs it — a card reading <code>—</code> is
    not implemented.
  </p>
</header>

<div class="legend">
  <button class="chip impl"   data-s="implemented" aria-pressed="true"><i></i>IMPLEMENTED <small>running + tested</small></button>
  <button class="chip partial" data-s="partial"     aria-pressed="true"><i></i>PARTIAL <small>works, incomplete</small></button>
  <button class="chip planned" data-s="planned"     aria-pressed="true"><i></i>PLANNED <small>not implemented</small></button>
  <button class="chip unwired" data-s="unwired"     aria-pressed="true"><i></i>UNWIRED <small>built, not connected</small></button>
</div>

${lanes}

<div class="flows">
  <h2>PRINCIPAL FLOWS</h2>
  ${flows}
</div>

<footer>
  ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join("  ·  ")}  ·  ${NODES.length} components
  <br>
  Generated by <code>scripts/build-map.js</code> — regenerate with <code>npm run build:map</code>
  · narrative detail in <code>docs/architecture.md</code>
</footer>

<script>
  // Toggle a status to dim those cards.
  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      const s = chip.dataset.s;
      const on = document.body.classList.toggle('hide-' + s);
      chip.setAttribute('aria-pressed', String(!on));
    });
  }
</script>
</body>
</html>
`;

const out = path.join(__dirname, "..", "docs", "architecture-map.html");
fs.writeFileSync(out, html, "utf8");
console.log(`wrote ${out}`);
console.log(`  nodes: ${NODES.length}  lanes: ${LANE_ORDER.length}  flows: ${FLOWS.length}`);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

// ── Verification ───────────────────────────────────────────────────────
// A map that cites files which do not exist is worse than no map: it looks
// like documentation and points nowhere. Fail loudly instead.

const root = path.join(__dirname, "..");
const problems = [];

for (const n of NODES) {
  if (n.file === "—") continue; // deliberately not implemented
  const rel = n.file.split(" ")[0].trim();
  if (!fs.existsSync(path.join(root, rel))) {
    problems.push(`${n.id}: cites missing file ${rel}`);
  }
}

const laneLabels = new Set(Object.values(LANE_LABELS));
for (const f of FLOWS) {
  for (const ref of [f.from, f.to]) {
    if (ref !== "every zone" && !laneLabels.has(ref)) {
      problems.push(`flow references unknown lane "${ref}"`);
    }
  }
}

for (const n of NODES) {
  if (!LANE_LABELS[n.lane]) problems.push(`${n.id}: unknown lane ${n.lane}`);
}

if (problems.length) {
  console.error("\nmap verification FAILED:");
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log(`  verified: ${NODES.length} file paths, ${FLOWS.length} flow endpoints`);
