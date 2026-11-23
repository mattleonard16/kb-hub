import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * The only write path agents can reach. Everything lands under `<knowledge>/inbox/`,
 * never overwrites, and is named by content hash so retries are idempotent.
 */
export function shortHash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12);
}

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type InboxWrite = { path: string; created: boolean };

export async function writeInbox(
  root: string,
  relPath: string,
  content: string | Uint8Array,
): Promise<InboxWrite> {
  const inbox = resolve(root, "inbox");
  const target = resolve(inbox, relPath);
  const rel = relative(inbox, target);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(target) === inbox) {
    throw new Error(`refusing to write outside inbox/: ${relPath}`);
  }
  const shown = join("inbox", rel).split(sep).join("/");
  try {
    await stat(target);
    return { path: shown, created: false };
  } catch {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: "wx" });
    return { path: shown, created: true };
  }
}
