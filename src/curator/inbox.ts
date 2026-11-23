import { appendFile, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { today } from "../lib/inbox.ts";
import { findInjection } from "../lib/injection.ts";

export type InboxEntry = {
  path: string;
  kind: "extraction" | "flag" | "export" | "source";
  bytes: number;
  /** Items flagged as instruction-like by ingest; the curator must not promote these. */
  suspicious: boolean;
};

async function walk(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "processed") out.push(...(await walk(full)));
    } else if (!e.name.startsWith(".")) out.push(full);
  }
  return out;
}

/** Unprocessed inbox files, oldest first, capped so one curator run stays inside plan limits. */
export async function listInbox(
  root: string,
  limit = 200,
): Promise<{ entries: InboxEntry[]; remaining: number }> {
  const inbox = join(root, "inbox");
  const files = (await walk(inbox)).sort();
  const entries: InboxEntry[] = [];
  for (const f of files.slice(0, limit)) {
    const rel = relative(root, f).split(sep).join("/");
    const kind: InboxEntry["kind"] = rel.startsWith("inbox/flags/")
      ? "flag"
      : rel.startsWith("inbox/exports/")
        ? "export"
        : rel.startsWith("inbox/sources/")
          ? "source"
          : "extraction";
    const bytes = (await stat(f)).size;
    // Ingest marks instruction-like extraction items; raw sources are scanned here.
    const suspicious =
      kind === "source"
        ? findInjection(await readFile(f, "utf8")).length > 0
        : kind !== "export" && (await readFile(f, "utf8")).includes("injection:");
    entries.push({ path: rel, kind, bytes, suspicious });
  }
  return { entries, remaining: Math.max(0, files.length - limit) };
}

export type LogOp = "ingest" | "query" | "lint" | "promote";

/**
 * Append one entry to wiki/log.md in Karpathy's format, `## [YYYY-MM-DD] <op> | <title>`,
 * so `grep "^## \[" wiki/log.md | tail` shows recent activity. The log is append-only.
 */
export async function appendLog(
  root: string,
  op: LogOp,
  title: string,
  lines: string[] = [],
  now = new Date(),
): Promise<void> {
  const log = join(root, "wiki/log.md");
  let existing = "";
  try {
    existing = await readFile(log, "utf8");
  } catch {
    existing = "# Log\n";
    await mkdir(dirname(log), { recursive: true });
    await Bun.write(log, existing);
  }
  const one = (t: string) => t.replace(/\s+/g, " ").trim();
  const entry = [
    `## [${today(now)}] ${op} | ${one(title)}`,
    "",
    ...lines.map((l) => `- ${one(l)}`),
  ];
  await appendFile(log, `${existing.endsWith("\n") ? "" : "\n"}\n${entry.join("\n")}\n`);
}

/**
 * Move processed inbox files into raw/, where sources are kept unchanged for good, and log the
 * ingest. A raw file that already exists is never overwritten.
 */
export async function markProcessed(
  root: string,
  paths: string[],
  note: string,
  now = new Date(),
): Promise<string[]> {
  const moves: Array<[string, string]> = [];
  for (const p of paths) {
    if (!p.startsWith("inbox/") || p.startsWith("inbox/processed/") || p.includes("..")) {
      throw new Error(`not an unprocessed inbox path: ${p}`);
    }
    const dest = join(root, "raw", p.slice("inbox/".length));
    if (
      await stat(dest).then(
        () => true,
        () => false,
      )
    )
      throw new Error(`${relative(root, dest)} already exists; raw sources are never overwritten`);
    moves.push([join(root, p), dest]);
  }
  const moved: string[] = [];
  for (const [from, dest] of moves) {
    await mkdir(dirname(dest), { recursive: true });
    await rename(from, dest);
    moved.push(relative(root, dest).split(sep).join("/"));
  }
  await appendLog(root, "ingest", note, moved, now);
  return moved;
}

export type StaleReport = { id: string; title: string; stale_after: string; status: string };

/** Concepts whose stale_after date has passed, for the "Still true?" section of the PR. */
export function staleConcepts(
  concepts: Array<{ id: string; meta: { title: string; stale_after?: string; status: string } }>,
  now = new Date(),
): StaleReport[] {
  const day = today(now);
  return concepts
    .filter(
      (c) => c.meta.stale_after && c.meta.stale_after <= day && c.meta.status !== "deprecated",
    )
    .map((c) => ({
      id: c.id,
      title: c.meta.title,
      stale_after: c.meta.stale_after ?? "",
      status: c.meta.status,
    }));
}
