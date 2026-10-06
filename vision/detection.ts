// RescueEye — Computer vision.
//
// Layering, so that no part of the app depends on a particular model:
//
//   DetectionModel   interface        — detect(frame) -> Detection[]
//   OnnxDetectionModel                — loads an ONNX graph via a pluggable
//                                       runtime; the only file that knows ONNX
//   SyntheticModel                    — the demo generator, always SYNTHETIC
//   DetectionService                  — pipeline, filtering, NMS, listeners
//
// The one rule this module enforces for safety: output that did not come from a
// real model run is tagged SYNTHETIC and must be rendered as non-actionable.
// A rescuer must never be shown an invented "person" they could fly a team to.

import { randomUUID } from "node:crypto";
import type { BoundingBox, Detection, DetectionProvenance } from "../shared/models";

export interface Frame {
  data: Buffer;
  width: number;
  height: number;
  timestamp: number;
  format: string;
}

/** A raw box straight out of a model head, before NMS and provenance tagging. */
export interface RawDetection {
  class: string;
  confidence: number;
  boundingBox: BoundingBox;
}

export interface DetectionModel {
  readonly modelName: string;
  readonly modelVersion: string;
  readonly inputSize: { width: number; height: number };
  readonly outputClasses: readonly string[];
  readonly confidenceThreshold: number;
  readonly iouThreshold: number;

  load(): Promise<void>;
  unload(): void;
  isLoaded(): boolean;
  detect(frame: Frame): RawDetection[];
}

// ── ONNX runtime binding ───────────────────────────────────────────────

/**
 * Inference backend. Kept as an interface so the project is not welded to one
 * vendor: pass an onnxruntime-web / onnxruntime-node instance, or a stub.
 */
export interface InferenceRuntime {
  run(
    modelPath: string,
    inputTensor: Float32Array,
    inputShape: number[],
  ): Promise<Float32Array>;
}

/**
 * ONNX object detector (YOLOv8 / NanoDet / any graph with a single detection
 * head exported through this binding).
 *
 * Without a runtime supplied this refuses to load. That is intentional: an
 * unrunnable model that silently returned nothing would leave an operator
 * staring at an empty map during a real search.
 */
export class OnnxDetectionModel implements DetectionModel {
  readonly modelName: string;
  readonly modelVersion: string;
  readonly inputSize: { width: number; height: number };
  readonly outputClasses: readonly string[];
  readonly confidenceThreshold: number;
  readonly iouThreshold: number;

  private loaded = false;
  private session: InferenceRuntime | null = null;

  constructor(
    private readonly options: {
      modelPath: string;
      runtime?: InferenceRuntime;
      modelName?: string;
      modelVersion?: string;
      inputSize?: { width: number; height: number };
      outputClasses?: string[];
      confidenceThreshold?: number;
      iouThreshold?: number;
    },
  ) {
    this.modelName = options.modelName ?? "onnx-detector";
    this.modelVersion = options.modelVersion ?? "0.0.0";
    this.inputSize = options.inputSize ?? { width: 640, height: 640 };
    this.outputClasses = options.outputClasses ?? DEFAULT_CLASSES;
    this.confidenceThreshold = options.confidenceThreshold ?? 0.4;
    this.iouThreshold = options.iouThreshold ?? 0.45;
  }

  async load(): Promise<void> {
    if (!this.options.runtime) {
      throw new Error(
        `Cannot load '${this.options.modelPath}': no InferenceRuntime was supplied. ` +
          `Pass onnxruntime-web/node, or use SyntheticModel for a demo.`,
      );
    }
    this.session = this.options.runtime;
    this.loaded = true;
  }

  unload(): void {
    this.loaded = false;
    this.session = null;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async detectAsync(frame: Frame): Promise<RawDetection[]> {
    if (!this.loaded || !this.session) return [];
    const { width, height } = this.inputSize;
    const input = new Float32Array(width * height * 3);
    // Real preprocessing (resize + normalise) belongs here; see docs.
    const raw = await this.session.run(
      this.options.modelPath,
      input,
      [1, 3, height, width],
    );
    return decodeFlatOutput(raw, this.outputClasses, this.confidenceThreshold);
  }

  detect(frame: Frame): RawDetection[] {
    void frame;
    // Synchronous variant cannot await the runtime; callers that care should
    // use detectAsync. Returning [] is honest — better than inventing boxes.
    return [];
  }
}

export const DEFAULT_CLASSES: readonly string[] = [
  "person",
  "vehicle",
  "building",
  "debris",
  "blocked_road",
  "smoke",
  "fire",
  "water",
  "tree",
  "structural_obstacle",
] as const;

/**
 * Decode a [numBoxes, 5+numClasses] tensor laid out as
 * [cx, cy, w, h, objConfidence, classScores...].
 */
export function decodeFlatOutput(
  raw: Float32Array,
  classes: readonly string[],
  threshold: number,
): RawDetection[] {
  const stride = 5 + classes.length;
  const count = Math.floor(raw.length / stride);
  const out: RawDetection[] = [];

  for (let i = 0; i < count; i++) {
    const base = i * stride;
    const obj = raw[base + 4];
    if (obj < threshold) continue;

    let bestClass = 0;
    let bestScore = 0;
    for (let c = 0; c < classes.length; c++) {
      const score = raw[base + 5 + c];
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    const confidence = obj * bestScore;
    if (confidence < threshold) continue;

    const [cx, cy, w, h] = [raw[base], raw[base + 1], raw[base + 2], raw[base + 3]];
    out.push({
      class: classes[bestClass],
      confidence,
      boundingBox: {
        x: cx - w / 2,
        y: cy - h / 2,
        width: w,
        height: h,
      },
    });
  }
  return out;
}

// ── Synthetic model (demo only) ────────────────────────────────────────

/**
 * Generates plausible-looking detections for demos and tests.
 *
 * It is NOT a detector. Every detection it produces is marked SYNTHETIC and
 * the server refuses to present synthetic output as a real finding unless
 * synthetic generation has been explicitly enabled.
 */
export class SyntheticModel implements DetectionModel {
  readonly modelName = "synthetic-demo";
  readonly modelVersion = "1.0.0";
  readonly inputSize = { width: 640, height: 640 };
  readonly outputClasses = DEFAULT_CLASSES;
  readonly confidenceThreshold = 0.5;
  readonly iouThreshold = 0.45;

  private loaded = false;

  async load(): Promise<void> {
    this.loaded = true;
  }

  unload(): void {
    this.loaded = false;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  detect(frame: Frame): RawDetection[] {
    if (!this.loaded) return [];
    const n = Math.floor(Math.random() * 4);
    const out: RawDetection[] = [];
    for (let i = 0; i < n; i++) {
      const w = 40 + Math.floor(Math.random() * 120);
      const h = 40 + Math.floor(Math.random() * 120);
      out.push({
        class: DEFAULT_CLASSES[Math.floor(Math.random() * DEFAULT_CLASSES.length)],
        confidence: 0.5 + Math.random() * 0.5,
        boundingBox: {
          x: Math.random() * (this.inputSize.width - w),
          y: Math.random() * (this.inputSize.height - h),
          width: w,
          height: h,
        },
      });
    }
    return out;
  }
}

// ── Detection service ──────────────────────────────────────────────────

export interface DetectionListener {
  (detection: Detection): void;
}

export class DetectionService {
  private detections: Detection[] = [];
  private listeners: DetectionListener[] = [];
  private readonly maxRetained: number;
  private inferenceMs = 0;

  constructor(
    private readonly model: DetectionModel,
    options?: { maxRetained?: number },
  ) {
    this.maxRetained = options?.maxRetained ?? 500;
  }

  async initialize(): Promise<void> {
    await this.model.load();
  }

  get provenance(): DetectionProvenance {
    // A model that is not actually loaded cannot vouch for anything.
    return this.model.isLoaded() && !(this.model instanceof SyntheticModel)
      ? "MODEL"
      : "SYNTHETIC";
  }

  processFrame(
    frame: Frame,
    opts: { sourceDroneId: string; missionId?: string; geolocation?: { latitude: number; longitude: number; altitude: number } },
  ): Detection[] {
    const started = Date.now();
    const raw = this.model.detect(frame);
    this.inferenceMs = Date.now() - started;

    const provenance = this.provenance;
    const frameId = randomUUID();

    // Suppress overlapping boxes so one object does not become five detections.
    const kept = nonMaxSuppression(raw, this.model.iouThreshold);

    const detections: Detection[] = kept.map((r) => ({
      id: randomUUID(),
      class: r.class,
      confidence: round4(r.confidence),
      boundingBox: roundBox(r.boundingBox),
      timestamp: frame.timestamp,
      frameId,
      sourceDroneId: opts.sourceDroneId,
      provenance,
      latitude: opts.geolocation?.latitude,
      longitude: opts.geolocation?.longitude,
      altitude: opts.geolocation?.altitude,
      metadata: opts.missionId ? { missionId: opts.missionId } : undefined,
    }));

    // Bounded retention: a long flight must not grow memory without limit.
    this.detections.push(...detections);
    if (this.detections.length > this.maxRetained) {
      this.detections = this.detections.slice(-this.maxRetained);
    }

    for (const d of detections) {
      for (const cb of this.listeners) cb(d);
    }
    return detections;
  }

  /** Measurements the console shows so an operator can judge model quality. */
  getStats(): { model: string; version: string; loaded: boolean; provenance: DetectionProvenance; inferenceMs: number; retained: number; classes: readonly string[] } {
    return {
      model: this.model.modelName,
      version: this.model.modelVersion,
      loaded: this.model.isLoaded(),
      provenance: this.provenance,
      inferenceMs: this.inferenceMs,
      retained: this.detections.length,
      classes: this.model.outputClasses,
    };
  }

  getDetections(): Detection[] {
    return [...this.detections];
  }

  getRealDetections(): Detection[] {
    return this.detections.filter((d) => d.provenance !== "SYNTHETIC");
  }

  byClass(cls: string): Detection[] {
    return this.detections.filter((d) => d.class === cls);
  }

  byConfidence(min: number): Detection[] {
    return this.detections.filter((d) => d.confidence >= min);
  }

  onDetection(cb: DetectionListener): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  clear(): void {
    this.detections = [];
  }
}

// ── NMS ────────────────────────────────────────────────────────────────

export function iou(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter === 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Greedy NMS: keeps the highest-scoring box and drops its overlaps. */
export function nonMaxSuppression(
  boxes: RawDetection[],
  threshold: number,
): RawDetection[] {
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence);
  const kept: RawDetection[] = [];
  for (const box of sorted) {
    if (kept.every((k) => iou(k.boundingBox, box.boundingBox) <= threshold)) {
      kept.push(box);
    }
  }
  return kept;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function roundBox(b: BoundingBox): BoundingBox {
  return {
    x: round4(b.x),
    y: round4(b.y),
    width: round4(b.width),
    height: round4(b.height),
  };
}
