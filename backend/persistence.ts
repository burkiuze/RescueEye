// RescueEye — Durable storage.
//
// After a search-and-rescue sortie the flight record is the evidence: it is
// what gets reviewed to decide whether the area was actually covered, and what
// gets read when someone asks "was that building checked?".
//
// The previous implementation held missions and events in a Map and an array,
// which meant a server restart silently erased the record of a mission that a
// team had flown. This store appends to a JSON Lines file and keeps an index
// in memory for fast lookup.
//
// JSONL is deliberate: each record is written and flushed independently, so a
// crash mid-mission truncates at most the final line rather than corrupting the
// whole history file. On load, a malformed trailing line is skipped rather than
// throwing the whole file away.

import { createWriteStream, existsSync, readFileSync, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export type StoreKind = "missions" | "events" | "detections" | "audit";

export class JsonlStore<T extends { id: string }> {
  private index = new Map<string, T>();
  private stream: WriteStream | null = null;
  private readonly filePath: string | null;

  constructor(
    private readonly kind: StoreKind,
    filePath?: string,
  ) {
    this.filePath = filePath ?? null;
    if (this.filePath) {
      // An unwritable DATA_DIR used to throw straight out of the constructor,
      // which meant out of `new RescueEyeServer(...)`, which meant the process
      // died before it ever bound a port — with no indication of why. Degrade to
      // in-memory instead and let the health endpoint report the fault.
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
      } catch (err) {
        this.degradedReason = `mkdir failed: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
      this.load();
      try {
        this.stream = createWriteStream(this.filePath, { flags: "a" });
      } catch (err) {
        this.degradedReason = `open failed: ${err instanceof Error ? err.message : String(err)}`;
        this.stream = null;
        return;
      }
      // An unhandled 'error' on a WriteStream is an uncaught exception. Disk
      // full, permissions revoked, filesystem remounted — any of these would
      // take the whole command centre down mid-sortie.
      this.stream.on("error", (err) => {
        this.degradedReason = `write failed: ${err instanceof Error ? err.message : String(err)}`;
        this.writeFailures++;
        this.stream = null;
      });
    }
  }

  /** Records skipped because they could not be parsed. Surfaced in /api/health. */
  public corruptLines = 0;
  /** Records that could not be written. Surfaced in /api/health. */
  public writeFailures = 0;
  /** Non-null when the store has fallen back to in-memory. */
  public degradedReason: string | null = null;

  /** True when the store can no longer persist. */
  get degraded(): boolean {
    return this.filePath !== null && this.stream === null;
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as T;
        if (record && typeof record.id === "string") {
          this.index.set(record.id, record);
        } else {
          this.corruptLines++;
        }
      } catch {
        // A truncated final line is the expected shape of a crash; skip it and
        // keep every complete record before it.
        this.corruptLines++;
      }
    }
  }

  put(record: T): T {
    this.index.set(record.id, record);
    if (this.stream) {
      // The event log is the flight record. Losing a line silently is worse
      // than knowing it failed, so the write error is recorded rather than
      // swallowed, and the record stays in memory where it can still be read.
      try {
        this.stream.write(`${JSON.stringify(record)}\n`);
      } catch (err) {
        this.writeFailures++;
        this.degradedReason = `write threw: ${err instanceof Error ? err.message : String(err)}`;
        this.stream = null;
      }
    }
    return record;
  }

  get(id: string): T | undefined {
    return this.index.get(id);
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  all(): T[] {
    return [...this.index.values()];
  }

  filter(predicate: (record: T) => boolean): T[] {
    return this.all().filter(predicate);
  }

  get size(): number {
    return this.index.size;
  }

  /**
   * Append-only updates. Used for records that are legally immutable once
   * written (events, audit) so a later caller cannot rewrite history.
   */
  append(record: T): T {
    return this.put(record);
  }

  async close(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolve) => this.stream!.end(resolve));
    this.stream = null;
  }
}

/**
 * In-memory store used when no data directory is configured (tests, demos).
 * Exposes the same surface as JsonlStore so services do not branch on it —
 * including the health fields, so SystemHealthManager can probe either kind
 * without a type check.
 */
export class MemoryStore<T extends { id: string }> {
  private index = new Map<string, T>();
  public corruptLines = 0;
  /** Always zero: nothing on disk to fail. */
  public writeFailures = 0;
  /** Reason this store is not durable. A test store is intentionally so. */
  public degradedReason: string | null = "in-memory store (no data directory configured)";

  constructor(readonly kind: StoreKind) {}

  /**
   * An in-memory store is not durable by design. Reporting it as degraded keeps
   * the health aggregate honest in tests and demos instead of implying the
   * flight record is safe when it is not.
   */
  get degraded(): boolean {
    return true;
  }

  put(record: T): T {
    this.index.set(record.id, record);
    return record;
  }

  get(id: string): T | undefined {
    return this.index.get(id);
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  all(): T[] {
    return [...this.index.values()];
  }

  filter(predicate: (record: T) => boolean): T[] {
    return this.all().filter(predicate);
  }

  get size(): number {
    return this.index.size;
  }

  append(record: T): T {
    return this.put(record);
  }

  async close(): Promise<void> {
    /* nothing to flush */
  }
}

export type AnyStore<T extends { id: string }> = JsonlStore<T> | MemoryStore<T>;
