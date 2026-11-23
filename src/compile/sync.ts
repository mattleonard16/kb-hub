import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Knowledge } from "../index/load.ts";
import {
  alwaysOn,
  conceptHash,
  PASTE_LIMITS,
  pasteBlock,
  profileSection,
  TARGETS,
  upsertMarkedSection,
} from "./compile.ts";

const MANAGED = ".kb-managed";

export type SyncTarget = {
  name: "claude-code" | "codex";
  instructions: string;
  skillsDir: string;
  lines: number;
};

/** Default locations; override with KB_CLAUDE_HOME / KB_CODEX_HOME (used by tests). */
export function defaultTargets(env = process.env): SyncTarget[] {
  const claude = env.KB_CLAUDE_HOME ?? join(homedir(), ".claude");
  const codex = env.KB_CODEX_HOME ?? join(homedir(), ".codex");
  return [
    {
      name: "claude-code",
      instructions: join(claude, "CLAUDE.md"),
      skillsDir: join(claude, "skills"),
      lines: TARGETS.claude.lines,
    },
    {
      name: "codex",
      instructions: join(codex, "AGENTS.md"),
      skillsDir: join(codex, "skills"),
      lines: TARGETS.agents.lines,
    },
  ];
}

async function readOr(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export type SyncReport = {
  target: string;
  instructions: string;
  conceptCount: number;
  omitted: string[];
  skillsCopied: string[];
  skillsSkipped: string[];
  dryRun: boolean;
};

/**
 * Write the profile between kb markers in each tool's instructions file and copy skills.
 * Never touches hand-written lines, and never overwrites a skill folder kb didn't create.
 */
export async function syncTargets(
  k: Knowledge,
  targets = defaultTargets(),
  opts: { dryRun?: boolean } = {},
): Promise<SyncReport[]> {
  const reports: SyncReport[] = [];
  for (const t of targets) {
    const profile = profileSection(k, t.lines);
    const current = await readOr(t.instructions, "");
    const next = upsertMarkedSection(current, profile.text);
    const copied: string[] = [];
    const skipped: string[] = [];
    if (!opts.dryRun) {
      await mkdir(dirname(t.instructions), { recursive: true });
      if (next !== current) await writeFile(t.instructions, next);
    }
    for (const s of k.skills) {
      const dest = join(t.skillsDir, s.name);
      if ((await exists(dest)) && !(await exists(join(dest, MANAGED)))) {
        skipped.push(`${s.name} (exists and was not created by kb)`);
        continue;
      }
      if (!opts.dryRun) {
        await rm(dest, { recursive: true, force: true });
        await mkdir(t.skillsDir, { recursive: true });
        await cp(s.dir, dest, { recursive: true });
        await writeFile(
          join(dest, MANAGED),
          "Managed by kb-hub sync. Edit the skill in the knowledge repo instead.\n",
        );
      }
      copied.push(s.name);
    }
    reports.push({
      target: t.name,
      instructions: t.instructions,
      conceptCount: profile.conceptIds.length,
      omitted: profile.omitted,
      skillsCopied: copied,
      skillsSkipped: skipped,
      dryRun: !!opts.dryRun,
    });
  }
  return reports;
}

/** Per-tool record of which concept versions were last delivered. Lives outside the knowledge repo. */
export type DeliveryState = Record<string, { at: string; concepts: Record<string, string> }>;

export function statePath(env = process.env): string {
  return env.KB_STATE_FILE ?? join(homedir(), ".kb", "state.json");
}

export async function readState(path = statePath()): Promise<DeliveryState> {
  return JSON.parse(await readOr(path, "{}")) as DeliveryState;
}

export async function recordDelivery(
  tool: string,
  k: Knowledge,
  path = statePath(),
  now = new Date(),
): Promise<void> {
  const state = await readState(path);
  state[tool] = {
    at: now.toISOString(),
    concepts: Object.fromEntries(alwaysOn(k).map((c) => [c.id, conceptHash(c)])),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

export const ALL_DELIVERY_TOOLS = ["claude-code", "codex", ...Object.keys(PASTE_LIMITS)];

export type ToolStatus = { tool: string; last_delivered: string | null; changes_behind: number };

/** How many always-on concepts changed (added, edited or removed) since each tool's last delivery. */
export function deliveryStatus(k: Knowledge, state: DeliveryState): ToolStatus[] {
  const now = Object.fromEntries(alwaysOn(k).map((c) => [c.id, conceptHash(c)]));
  return ALL_DELIVERY_TOOLS.map((tool) => {
    const prev = state[tool];
    if (!prev) return { tool, last_delivered: null, changes_behind: Object.keys(now).length };
    const ids = new Set([...Object.keys(now), ...Object.keys(prev.concepts)]);
    let behind = 0;
    for (const id of ids) if (now[id] !== prev.concepts[id]) behind++;
    return { tool, last_delivered: prev.at, changes_behind: behind };
  });
}

export function pasteFor(tool: string, k: Knowledge): string {
  const limit = PASTE_LIMITS[tool];
  if (!limit)
    throw new Error(`no paste block for ${tool}. Options: ${Object.keys(PASTE_LIMITS).join(", ")}`);
  return pasteBlock(k, limit).text;
}
