// RescueEye — Computer Vision Detection System
// ONNX-compatible, modular, replaceable detection model.

import type { Detection, BoundingBox } from "../shared/models";

export interface DetectionModel {
  readonly modelName: string;
  readonly modelVersion: string;
  readonly inputSize: { width: number; height: number };
  readonly outputClasses: string[];
  readonly confidenceThreshold: number;
  readonly iouThreshold: number;
  load(): Promise<void>;
  unload(): void;
  detect(frame: Buffer): Detection[];
  isLoaded(): boolean;
}

export interface DetectionResult {
  id: string;
  class: string;
  confidence: number;
  boundingBox: BoundingBox;
}

// ── ONNX Detection Model (placeholder) ────────────────────────────────
// In production this would load and run an ONNX model.
// Architecture supports YOLOv8, NanoDet, or any ONNX-exported detector.

export class OnnxDetectionModel implements DetectionModel {
  readonly modelName: string;
  readonly modelVersion: string;
  readonly inputSize: { width: number; height: number };
  readonly outputClasses: string[];
  readonly confidenceThreshold: number;
  readonly iouThreshold: number;

  private _loaded = false;

  constructor(config: {
    modelName?: string;
    modelVersion?: string;
    inputSize?: { width: number; height: number };
    outputClasses?: string[];
    confidenceThreshold?: number;
    iouThreshold?: number;
  } = {}) {
    this.modelName = config.modelName ?? "RescueEye-YOLOv8";
    this.modelVersion = config.modelVersion ?? "1.0.0";
    this.inputSize = config.inputSize ?? { width: 640, height: 640 };
    this.outputClasses = config.outputClasses ?? [
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
    ];
    this.confidenceThreshold = config.confidenceThreshold ?? 0.4;
    this.iouThreshold = config.iouThreshold ?? 0.45;
  }

  async load(): Promise<void> {
    // In production: load ONNX model via onnxruntime-web or onnxruntime-node
    // await ort.InferenceSession.create(modelPath);
    await new Promise((resolve) => setTimeout(resolve, 100));
    this._loaded = true;
  }

  unload(): void {
    this._loaded = false;
  }

  isLoaded(): boolean {
    return this._loaded;
  }

  detect(frame: Buffer): Detection[] {
    if (!this._loaded) {
      return [];
    }

    // In production: run ONNX inference on the frame buffer.
    // This returns mock detections for demo/development purposes.
    return this._generateMockDetections(frame);
  }

  // ── Private ──────────────────────────────────────────────────

  private _generateMockDetections(frame: Buffer): Detection[] {
    const detections: Detection[] = [];
    const count = Math.floor(Math.random() * 4);

    for (let i = 0; i < count; i++) {
      const cls = this.outputClasses[Math.floor(Math.random() * this.outputClasses.length)];
      const w = 40 + Math.floor(Math.random() * 120);
      const h = 40 + Math.floor(Math.random() * 120);

      detections.push({
        id: `onnx-det-${Date.now()}-${i}`,
        class: cls,
        confidence: this.confidenceThreshold + Math.random() * (1 - this.confidenceThreshold),
        boundingBox: {
          x: Math.floor(Math.random() * (this.inputSize.width - w)),
          y: Math.floor(Math.random() * (this.inputSize.height - h)),
          width: w,
          height: h,
        },
        timestamp: Date.now(),
        frameId: `frame-${Date.now()}`,
        sourceDroneId: "",
      });
    }

    return detections;
  }
}

// ── Detection Service ─────────────────────────────────────────────────
// Orchestrates camera pipeline + vision model + detection delivery.

export interface DetectionListener {
  (detection: Detection): void;
}

export class DetectionService {
  private model: DetectionModel;
  private detections: Detection[] = [];
  private listeners: DetectionListener[] = [];
  private _maxDetections = 500;

  constructor(model: DetectionModel) {
    this.model = model;
  }

  async initialize(): Promise<void> {
    await this.model.load();
  }

  processFrame(frame: Buffer, frameId: string, sourceDroneId: string): Detection[] {
    const results = this.model.detect(frame);
    const now = Date.now();

    const detections: Detection[] = results.map((r) => ({
      id: r.id,
      class: r.class,
      confidence: r.confidence,
      boundingBox: r.boundingBox,
      timestamp: now,
      frameId,
      sourceDroneId,
    }));

    // Store detections
    this.detections.push(...detections);
    if (this.detections.length > this._maxDetections) {
      this.detections = this.detections.slice(-this._maxDetections);
    }

    // Notify listeners
    detections.forEach((d) => {
      this.listeners.forEach((cb) => cb(d));
    });

    return detections;
  }

  getDetections(): Detection[] {
    return [...this.detections];
  }

  getDetectionsByClass(cls: string): Detection[] {
    return this.detections.filter((d) => d.class === cls);
  }

  getDetectionsByConfidence(minConfidence: number): Detection[] {
    return this.detections.filter((d) => d.confidence >= minConfidence);
  }

  onDetection(cb: DetectionListener): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  clearDetections(): void {
    this.detections = [];
  }

  getModelInfo(): { name: string; version: string; classes: string[]; loaded: boolean } {
    return {
      name: this.model.modelName,
      version: this.model.modelVersion,
      classes: this.model.outputClasses,
      loaded: this.model.isLoaded(),
    };
  }
}

// ── Vision Worker ─────────────────────────────────────────────────────
// Runs detection asynchronously, doesn't block telemetry or UI.

export class VisionWorker {
  private detectionService: DetectionService;
  private _running = false;
  private _intervalId: number | NodeJS.Timeout | null = null;

  constructor(detectionService: DetectionService) {
    this.detectionService = detectionService;
  }

  start(intervalMs: number = 100): void {
    if (this._running) return;
    this._running = true;
    this._intervalId = setInterval(() => {
      // Vision worker processes frames from the camera pipeline's buffer
      // In production: pull from FrameBuffer, run inference, push results
    }, intervalMs);
  }

  stop(): void {
    this._running = false;
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  isRunning(): boolean {
    return this._running;
  }
}
