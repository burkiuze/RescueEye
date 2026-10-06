// RescueEye — Authentication, authorisation and audit trail.
//
// A command centre for a real UAV is a safety-critical system: anyone who can
// reach it can move an aircraft over people and buildings. These three pieces
// are deliberately separate so each can be reasoned about (and tested) alone:
//
//   AuthService    — who is making this request?
//   Authorizer     — are they allowed to do this specific thing?
//   AuditLog       — what did they actually do, and what happened?
//
// Design rules that matter for safety:
//  * Constant-time token comparison, so a token cannot be guessed byte by byte.
//  * Fail closed. An unknown token is never treated as "anonymous but allowed";
//    it is rejected. There is no default-allow path.
//  * Every denial is audited too. Repeated 403s are exactly the signal you want
//    when someone is probing the system.
//  * Overrides expire. A standing "ignore failsafes" switch is how people get
//    hurt, so an override is a bounded, reasoned, attributed decision.

import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type {
  AuditEntry,
  Capability,
  Operator,
  OverrideRecord,
  Role,
} from "../shared/models";
import { roleHasCapability } from "../shared/models";

export interface OperatorRecord extends Operator {
  /** Salted SHA-256 of the token; the token itself is never stored. */
  tokenHash: string;
  tokenSalt: string;
}

export interface AuthFailure {
  ok: false;
  reason: "missing_token" | "invalid_token" | "disabled" | "malformed";
}

export interface AuthSuccess {
  ok: true;
  operator: OperatorRecord;
}

export type AuthResult = AuthSuccess | AuthFailure;

export class AuthService {
  private operators = new Map<string, OperatorRecord>();

  /**
   * Provision an operator and return the plaintext token exactly once.
   * The caller is responsible for handing it to the operator securely; we
   * cannot recover it afterwards.
   */
  provision(username: string, role: Role): { operator: Operator; token: string } {
    const salt = randomBytes(16).toString("hex");
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token, salt);
    const id = `op-${randomBytes(6).toString("hex")}`;

    const record: OperatorRecord = {
      id,
      username,
      role,
      createdAt: Date.now(),
      tokenHash,
      tokenSalt: salt,
    };
    this.operators.set(id, record);

    // Do not leak the hash through the public shape.
    const { tokenHash: _h, tokenSalt: _s, ...pub } = record;
    return { operator: pub, token };
  }

  authenticate(token: string | undefined | null): AuthResult {
    if (!token || token.length === 0) return { ok: false, reason: "missing_token" };

    // Each operator has a unique salt, so a token must be re-hashed per
    // operator. Compare every candidate in constant time and keep looking
    // after a match so total work does not depend on which one hit.
    let match: OperatorRecord | undefined;
    for (const op of this.operators.values()) {
      const candidate = Buffer.from(hashToken(token, op.tokenSalt), "hex");
      const known = Buffer.from(op.tokenHash, "hex");
      if (candidate.length === known.length && timingSafeEqual(candidate, known)) {
        match ??= op;
      }
    }

    if (!match) return { ok: false, reason: "invalid_token" };
    if (match.disabled) return { ok: false, reason: "disabled" };

    return { ok: true, operator: match };
  }

  disable(operatorId: string): boolean {
    const op = this.operators.get(operatorId);
    if (!op) return false;
    op.disabled = true;
    return true;
  }

  list(): Operator[] {
    return [...this.operators.values()].map(({ tokenHash: _h, tokenSalt: _s, ...pub }) => pub);
  }
}

/** Extract a bearer token from an Authorization header value. */
export function parseBearer(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

function hashToken(token: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${token}`).digest("hex");
}

/**
 * Compares two strings without leaking their contents through timing.
 * Length is compared first because timingSafeEqual throws on a mismatch; the
 * comparison work is still performed on a same-length dummy so that the
 * failure path does not return measurably faster than the success path.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// ── Audit log ──────────────────────────────────────────────────────────

export class AuditLog {
  private entries: AuditEntry[] = [];
  private readonly limit: number;

  constructor(limit = 10_000) {
    this.limit = limit;
  }

  record(entry: Omit<AuditEntry, "id" | "at"> & { at?: number }): AuditEntry {
    const full: AuditEntry = {
      id: `aud-${randomBytes(6).toString("hex")}`,
      at: entry.at ?? Date.now(),
      actorId: entry.actorId,
      actorUsername: entry.actorUsername,
      actorRole: entry.actorRole,
      action: entry.action,
      target: entry.target,
      outcome: entry.outcome,
      detail: entry.detail,
    };
    this.entries.push(full);
    if (this.entries.length > this.limit) {
      // Keep the newest N; oldest entries are the ones least likely to be
      // relevant to a recent incident and most likely to be needed first.
      this.entries = this.entries.slice(-this.limit);
    }
    return full;
  }

  list(filter?: { actorId?: string; action?: string; outcome?: AuditEntry["outcome"] }): AuditEntry[] {
    let out = this.entries;
    if (filter?.actorId) out = out.filter((e) => e.actorId === filter.actorId);
    if (filter?.action) out = out.filter((e) => e.action === filter.action);
    if (filter?.outcome) out = out.filter((e) => e.outcome === filter.outcome);
    return [...out];
  }

  get size(): number {
    return this.entries.length;
  }
}

// ── Authorizer ─────────────────────────────────────────────────────────

export interface AuthorizationDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Central capability check plus the record of overrides.
 *
 * The important behaviour here is `canOverrideFailsafe`: a human holding
 * "failsafe:override" may suppress an automated failsafe, but only within a
 * bounded window and only for a recorded reason. Nothing else in the system
 * is allowed to cancel a failsafe on its own.
 */
export class Authorizer {
  private overrides = new Map<string, OverrideRecord>();

  constructor(
    private readonly audit: AuditLog,
    private readonly defaultOverrideDurationMs = 120_000,
  ) {}

  check(role: Role, capability: Capability): AuthorizationDecision {
    if (roleHasCapability(role, capability)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `role '${role}' lacks capability '${capability}'`,
    };
  }

  /**
   * Register a time-boxed override of an automated failsafe action.
   * The override applies to one safety state at a time and auto-expires.
   */
  grantOverride(args: {
    operator: Operator;
    safetyState: string;
    action: string;
    reason: string;
    durationMs?: number;
  }): OverrideRecord {
    const duration = args.durationMs ?? this.defaultOverrideDurationMs;
    const record: OverrideRecord = {
      id: `ovr-${randomBytes(6).toString("hex")}`,
      at: Date.now(),
      operatorId: args.operator.id,
      operatorUsername: args.operator.username,
      safetyState: args.safetyState,
      overriddenAction: args.action,
      reason: args.reason,
      expiresAt: Date.now() + duration,
    };
    this.overrides.set(args.safetyState, record);
    this.audit.record({
      actorId: args.operator.id,
      actorUsername: args.operator.username,
      actorRole: args.operator.role,
      action: "failsafe.override.grant",
      target: args.safetyState,
      outcome: "applied",
      detail: { reason: args.reason, expiresAt: record.expiresAt },
    });
    return record;
  }

  /** Returns the active override for a safety state, or undefined if expired/absent. */
  activeOverride(safetyState: string): OverrideRecord | undefined {
    const rec = this.overrides.get(safetyState);
    if (!rec) return undefined;
    if (Date.now() >= rec.expiresAt) {
      this.overrides.delete(safetyState);
      return undefined;
    }
    return rec;
  }

  isOverridden(safetyState: string): boolean {
    return this.activeOverride(safetyState) !== undefined;
  }

  clearOverride(safetyState: string, operator: Operator): boolean {
    const rec = this.overrides.get(safetyState);
    if (!rec) return false;
    this.overrides.delete(safetyState);
    this.audit.record({
      actorId: operator.id,
      actorUsername: operator.username,
      actorRole: operator.role,
      action: "failsafe.override.clear",
      target: safetyState,
      outcome: "applied",
      detail: { wasOverriddenAt: rec.at },
    });
    return true;
  }

  listOverrides(): OverrideRecord[] {
    return [...this.overrides.values()];
  }
}
