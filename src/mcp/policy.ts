import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Sensitivity } from "../schema/concept.ts";

/** Who is calling. `id` becomes `reported_by` on anything they write. */
export type Client = {
  id: string;
  scopes: Scope[];
  /** Hosted callers never see `sensitive`, whatever their scopes say. */
  hosted: boolean;
};

export type Scope =
  | "read:public"
  | "read:personal"
  | "read:sensitive"
  | "write:flags"
  | "write:ingest";

export const ALL_SCOPES: Scope[] = [
  "read:public",
  "read:personal",
  "read:sensitive",
  "write:flags",
  "write:ingest",
];

export function allowedSensitivity(c: Client): Sensitivity[] {
  const out: Sensitivity[] = [];
  if (c.scopes.includes("read:public")) out.push("public");
  if (c.scopes.includes("read:personal")) out.push("personal");
  if (c.scopes.includes("read:sensitive") && !c.hosted) out.push("sensitive");
  return out;
}

export const canRead = (c: Client) => allowedSensitivity(c).length > 0;
export const canFlag = (c: Client) => c.scopes.includes("write:flags");
export const canIngest = (c: Client) => c.scopes.includes("write:ingest");

/** Limits from the security plan. */
export const LIMITS = { callsPerMinute: 60, writesPerDay: 50 };

/** In-memory per-client rate limiter (one process; good enough for a single-user server). */
export class RateLimiter {
  private calls = new Map<string, number[]>();
  private writes = new Map<string, number[]>();

  constructor(private limits = LIMITS) {}

  check(clientId: string, isWrite: boolean, now = Date.now()): string | null {
    const recent = (this.calls.get(clientId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.limits.callsPerMinute) {
      return `rate limit: ${this.limits.callsPerMinute} calls a minute. Wait a minute and retry.`;
    }
    if (isWrite) {
      const day = (this.writes.get(clientId) ?? []).filter((t) => now - t < 86_400_000);
      if (day.length >= this.limits.writesPerDay) {
        return `rate limit: ${this.limits.writesPerDay} writes a day for this client. The curator processes the inbox nightly.`;
      }
      day.push(now);
      this.writes.set(clientId, day);
    }
    recent.push(now);
    this.calls.set(clientId, recent);
    return null;
  }
}

export type Lockdown = "off" | "read-only" | "closed";

/**
 * Kill switch and revocations. Read from a small JSON file (local) or env vars (hosted),
 * re-read at most every 2 seconds so `kb lockdown` and `kb revoke` apply without a restart.
 */
export class Controls {
  private cached: { at: number; lockdown: Lockdown; revoked: Set<string> } | null = null;

  constructor(
    private file?: string,
    private env = process.env,
  ) {}

  async current(now = Date.now()): Promise<{ lockdown: Lockdown; revoked: Set<string> }> {
    if (this.cached && now - this.cached.at < 2000) return this.cached;
    let lockdown = (this.env.KB_LOCKDOWN as Lockdown | undefined) ?? "off";
    const revoked = new Set(
      (this.env.KB_REVOKED_CLIENTS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (this.file) {
      try {
        const data = JSON.parse(await readFile(this.file, "utf8")) as {
          lockdown?: Lockdown;
          revoked?: string[];
        };
        if (data.lockdown) lockdown = data.lockdown;
        for (const r of data.revoked ?? []) revoked.add(r);
      } catch {
        // no controls file yet
      }
    }
    this.cached = { at: now, lockdown, revoked };
    return this.cached;
  }
}

export type AuditEntry = {
  at: string;
  client: string;
  tool: string;
  ok: boolean;
  query?: string;
  concept_ids?: string[];
  error?: string;
};

/** Audit log: who called what and which concept ids came back. Never stores bodies. */
export class AuditLog {
  constructor(private file?: string) {}

  async write(entry: AuditEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    if (!this.file) {
      process.stderr.write(line);
      return;
    }
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, line);
  }

  async read(): Promise<AuditEntry[]> {
    if (!this.file) return [];
    try {
      return (await readFile(this.file, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AuditEntry);
    } catch {
      return [];
    }
  }
}
