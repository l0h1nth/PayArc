import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Clock } from "../domain/types.js";
import type { AuthRole, RecoveryRepository } from "../storage/database.js";

export type AuthUser = {
  email: string;
  displayName: string;
  role: AuthRole;
};

export type AuthenticatedSession = {
  token: string;
  user: AuthUser;
  expiresAt: number;
};

type FailedAttempt = { count: number; resetAt: number };

const loginWindowSeconds = 15 * 60;
const maxLoginAttempts = 5;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class AuthService {
  private readonly attempts = new Map<string, FailedAttempt>();

  constructor(
    private readonly config: AppConfig["auth"],
    private readonly repository: RecoveryRepository,
    private readonly clock: Clock
  ) {}

  login(emailInput: string, password: string, remoteAddress: string): AuthenticatedSession | null {
    const now = this.clock.now();
    const email = emailInput.trim().toLowerCase();
    const attemptKey = sha256(`${remoteAddress}:${email}`).slice(0, 24);
    const previous = this.attempts.get(attemptKey);
    if (previous && previous.resetAt > now && previous.count >= maxLoginAttempts) {
      this.auditDenied("AUTH_LOGIN_RATE_LIMITED", { identity: sha256(email).slice(0, 16), retryAfter: previous.resetAt - now });
      return null;
    }
    if (previous && previous.resetAt <= now) this.attempts.delete(attemptKey);

    const user = this.config.users.find((candidate) => candidate.email === email);
    const expectedPassword = user?.password ?? "invalid-credential-sentinel";
    const salt = `${this.config.sessionSecret}:${email || "unknown"}`;
    const received = scryptSync(password, salt, 32);
    const expected = scryptSync(expectedPassword, salt, 32);
    if (!user || !timingSafeEqual(received, expected)) {
      const next = this.attempts.get(attemptKey);
      this.attempts.set(attemptKey, { count: (next?.count ?? 0) + 1, resetAt: next?.resetAt ?? now + loginWindowSeconds });
      this.auditDenied("AUTH_LOGIN_FAILED", { identity: sha256(email).slice(0, 16) });
      return null;
    }

    this.attempts.delete(attemptKey);
    this.repository.deleteExpiredAuthSessions(now);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + this.config.sessionTtlSeconds;
    this.repository.createAuthSession({
      tokenHash: sha256(token),
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: now,
      expiresAt
    });
    this.repository.appendAudit({
      kind: "AUTH_LOGIN_SUCCEEDED",
      actor: `merchant-auth:${user.role.toLowerCase()}`,
      data: { identity: sha256(user.email).slice(0, 16), role: user.role, expiresAt },
      now
    });
    return { token, user: { email: user.email, displayName: user.displayName, role: user.role }, expiresAt };
  }

  authenticate(token: string | null): Omit<AuthenticatedSession, "token"> | null {
    if (!token) return null;
    const session = this.repository.getAuthSession(sha256(token), this.clock.now());
    if (!session) return null;
    return {
      user: { email: session.email, displayName: session.displayName, role: session.role },
      expiresAt: session.expiresAt
    };
  }

  logout(token: string | null): boolean {
    if (!token) return false;
    const tokenHash = sha256(token);
    const session = this.repository.getAuthSession(tokenHash, this.clock.now());
    const revoked = this.repository.revokeAuthSession(tokenHash, this.clock.now());
    if (revoked) {
      this.repository.appendAudit({
        kind: "AUTH_LOGOUT",
        actor: session ? `merchant-auth:${session.role.toLowerCase()}` : "merchant-auth",
        data: { identity: session ? sha256(session.email).slice(0, 16) : "unknown" },
        now: this.clock.now()
      });
    }
    return revoked;
  }

  recordAccessDenied(path: string, role: AuthRole | null, reason: string): void {
    this.auditDenied("AUTH_ACCESS_DENIED", { path: path.slice(0, 160), role: role ?? "ANONYMOUS", reason });
  }

  private auditDenied(kind: string, data: Record<string, unknown>): void {
    this.repository.appendAudit({ kind, actor: "merchant-auth", data, now: this.clock.now() });
  }
}
