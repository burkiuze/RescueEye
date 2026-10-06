// RescueEye — Camera Pipeline
// Modular camera source → decoder → frame buffer → vision worker → overlay renderer → UI

import type { CameraSource, CameraStats, VideoFrame } from "../shared/models";

// ── Frame Buffer ───────────────────────────────────────────────────────
// Bounded queue — dropping old frames is preferable to blocking.

export class FrameBuffer {
  private buffer: VideoFrame[] = [];
  private maxSize: number;

  constructor(maxSize: number = 30) {
    this.maxSize = maxSize;
  }

  push(frame: VideoFrame): void {
    if (this.buffer.length >= this.maxSize) {
      // Drop oldest frame to avoid blocking
      this.buffer.shift();
    }
    this.buffer.push(frame);
  }

  pop(): VideoFrame | null {
    return this.buffer.shift() ?? null;
  }

  peek(): VideoFrame | null {
    return this.buffer[0] ?? null;
  }

  get size(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
  }
}

// ── Camera Pipeline ────────────────────────────────────────────────────

export interface CameraPipelineConfig {
  source: CameraSource;
  maxBufferSize: number;
  processIntervalMs: number;
}

export interface VisionResult {
  frameId: string;
  detections: Array<{
    id: string;
    class: string;
    confidence: number;
    boundingBox: { x: number; y: number; width: number; height: number };
  }>;
  processingTimeMs: number;
}

export interface VisionListener {
  (result: VisionResult): void;
}

export class CameraPipeline {
  private source: CameraSource;
  private buffer: FrameBuffer;
  private config: CameraPipelineConfig;
  private _running = false;
  private _intervalIds: (number | NodeJS.Timeout)[] = [];
  private _visionListeners: VisionListener[] = [];
  private _frameListeners: Array<(frame: VideoFrame) => void> = [];
  private _frameIdCounter = 0;

  constructor(config: CameraPipelineConfig) {
    this.source = config.source;
    this.buffer = new FrameBuffer(config.maxBufferSize);
    this.config = config;
  }

  async start(): Promise<void> {
    await this.source.start();
    this._running = true;

    // Frame ingestion at ~30 FPS
    const ingestId = setInterval(() => {
      if (!this._running) return;
      const frame = this._captureFrame();
      if (frame) {
        this.buffer.push(frame);
        this._frameListeners.forEach((cb) => cb(frame));
      }
    }, 33); // ~30 FPS
    this._intervalIds.push(ingestId);

    // Vision processing at ~10 Hz
    const visionId = setInterval(() => {
      if (!this._running) return;
      this._processFrame();
    }, this.config.processIntervalMs);
    this._intervalIds.push(visionId);
  }

  async stop(): Promise<void> {
    this._running = false;
    this._intervalIds.forEach((id) => clearInterval(id));
    this._intervalIds = [];
    await this.source.stop();
  }

  isRunning(): boolean {
    return this._running;
  }

  getStats(): CameraStats {
    return this.source.getStats();
  }

  getBuffer(): FrameBuffer {
    return this.buffer;
  }

  onFrame(cb: (frame: VideoFrame) => void): () => void {
    this._frameListeners.push(cb);
    return () => {
      this._frameListeners = this._frameListeners.filter((l) => l !== cb);
    };
  }

  onVisionResult(cb: VisionListener): () => void {
    this._visionListeners.push(cb);
    return () => {
      this._visionListeners = this._visionListeners.filter((l) => l !== cb);
    };
  }

  // ── Private ────────────────────────────────────────────────────────

  private _captureFrame(): VideoFrame | null {
    // In production, this would grab a frame from the camera source.
    // For the simulator/pipeline demo, we generate a synthetic frame.
    const frameId = `frame-${++this._frameIdCounter}-${Date.now()}`;
    return {
      data: Buffer.alloc(640 * 480 * 3), // placeholder
      width: 640,
      height: 480,
      timestamp: Date.now(),
      format: "RGB24",
    };
  }

  private _processFrame(): void {
    const frame = this.buffer.pop();
    if (!frame) return;

    const startTime = Date.now();

    // In production, this would run actual CV inference.
    // For now, generate mock detections.
    const result: VisionResult = {
      frameId: `frame-${++this._frameIdCounter}-${Date.now()}`,
      detections: this._generateMockDetections(),
      processingTimeMs: Date.now() - startTime,
    };

    this._visionListeners.forEach((cb) => cb(result));
  }

  private _generateMockDetections(): Array<{
    id: string;
    class: string;
    confidence: number;
    boundingBox: { x: number; y: number; width: number; height: number };
  }> {
    // Random mock detections for demo purposes
    const classes = ["person", "vehicle", "building", "debris", "smoke", "fire", "water", "tree"];
    const count = Math.floor(Math.random() * 3);
    const detections = [];
    for (let i = 0; i < count; i++) {
      detections.push({
        id: `det-${Date.now()}-${i}`,
        class: classes[Math.floor(Math.random() * classes.length)],
        confidence: 0.5 + Math.random() * 0.5,
        boundingBox: {
          x: Math.floor(Math.random() * 500),
          y: Math.floor(Math.random() * 400),
          width: 50 + Math.floor(Math.random() * 100),
          height: 50 + Math.floor(Math.random() * 100),
        },
      });
    }
    return detections;
  }
}

// ── RTSP Camera Source (placeholder) ───────────────────────────────────

export class RtspCameraSource implements CameraSource {
  private _running = false;
  private _stats: CameraStats = {
    resolution: "1920x1080",
    fps: 30,
    streamStatus: "inactive",
    latencyMs: 0,
    recording: false,
    sourceType: "rtsp",
  };
  private _callbacks: Array<(frame: VideoFrame) => void> = [];

  async start(): Promise<void> {
    this._running = true;
    this._stats.streamStatus = "active";
    // In production: open RTSP connection, decode H.264/H.265 stream
  }

  async stop(): Promise<void> {
    this._running = false;
    this._stats.streamStatus = "inactive";
  }

  isRunning(): boolean {
    return this._running;
  }

  getStats(): CameraStats {
    return this._stats;
  }

  onFrame(cb: (frame: VideoFrame) => void): () => void {
    this._callbacks.push(cb);
    return () => {
      this._callbacks = this._callbacks.filter((c) => c !== cb);
    };
  }
}

// ── Local Camera Source (placeholder) ──────────────────────────────────

export class LocalCameraSource implements CameraSource {
  private _running = false;
  private _stats: CameraStats = {
    resolution: "1280x720",
    fps: 30,
    streamStatus: "inactive",
    latencyMs: 0,
    recording: false,
    sourceType: "local",
  };
  private _callbacks: Array<(frame: VideoFrame) => void> = [];

  async start(): Promise<void> {
    this._running = true;
    this._stats.streamStatus = "active";
    // In production: open local camera device via WebRTC or MediaStream
  }

  async stop(): Promise<void> {
    this._running = false;
    this._stats.streamStatus = "inactive";
  }

  isRunning(): boolean {
    return this._running;
  }

  getStats(): CameraStats {
    return this._stats;
  }

  onFrame(cb: (frame: VideoFrame) => void): () => void {
    this._callbacks.push(cb);
    return () => {
      this._callbacks = this._callbacks.filter((c) => c !== cb);
    };
  }
}
