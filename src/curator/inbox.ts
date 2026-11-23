import { appendFile, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { today } from "../lib/inbox.ts";

export type InboxEntry = {
  path: string;
  kind: "extraction" | "flag" | "export";
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
    const kind = rel.startsWith("inbox/flags/")
      ? "flag"
      : rel.startsWith("inbox/exports/")
        ? "export"
        : "extraction";
    const bytes = (await stat(f)).size;
    const suspicious = kind !== "export" && (await readFile(f, "utf8")).includes("injection:");
    entries.push({ path: rel, kind, bytes, suspicious });
  }
  return { entries, remaining: Math.max(0, files.length - limit) };
}

/** Move processed inbox files to inbox/processed/ and record the run in knowledge/log.md. */
export async function markProcessed(
  root: string,
  paths: string[],
  note: string,
  now = new Date(),
): Promise<string[]> {
  const moved: string[] = [];
  for (const p of paths) {
    if (!p.startsWith("inbox/") || p.startsWith("inbox/processed/") || p.includes("..")) {
      throw new Error(`not an unprocessed inbox path: ${p}`);
    }
    const dest = join(root, "inbox/processed", p.slice("inbox/".length));
    await mkdir(dirname(dest), { recursive: true });
    await rename(join(root, p), dest);
    moved.push(relative(root, dest).split(sep).join("/"));
  }
  const log = join(root, "knowledge/log.md");
  const day = today(now);
  let existing = "";
  try {
    existing = await readFile(log, "utf8");
  } catch {
    existing = "# Log\n";
  }
  const heading = `## ${day}`;
  const entry = `- ${note.replace(/\s+/g, " ").trim()} (${paths.length} inbox file${paths.length === 1 ? "" : "s"})\n`;
  if (existing.includes(`${heading}\n`)) {
    await Bun.write(log, existing.replace(new RegExp(`${heading}\\n+`), `${heading}\n\n${entry}`));
  } else {
    await appendFile(log, `${existing.endsWith("\n") ? "" : "\n"}\n${heading}\n\n${entry}`);
  }
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
