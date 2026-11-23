import { existsSync, readdirSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";

/** Only these top-level folders are served; everything else in the knowledge repo is skipped. */
const SERVED = ["knowledge/", "skills/"];
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
/** Written into every snapshot. A folder without it is someone's checkout and is never replaced. */
export const SNAPSHOT_MARKER = ".kb-snapshot";

export type SnapshotResult = { files: number; ref: string; bytes: number };

/**
 * Download the knowledge repo as one GitHub zipball and unpack its knowledge/ and skills/
 * folders into `dest`. This replaces `git clone` and `git pull`, so the hosted server needs
 * no git binary and no persistent disk: any host with fetch and a temp folder can run it.
 * The new copy is written next to `dest` and swapped in, so a failed download keeps the old one.
 * `dest` must be missing or an earlier snapshot, so a local checkout can never be overwritten.
 */
export async function fetchSnapshot(opts: {
  repo: string;
  token: string;
  dest: string;
  ref?: string;
  apiBase?: string;
}): Promise<SnapshotResult> {
  if (!/^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/.test(opts.repo))
    throw new Error(`bad repo name: ${opts.repo}`);
  const occupied = existsSync(opts.dest) && readdirSync(opts.dest).length > 0;
  if (occupied && !existsSync(join(opts.dest, SNAPSHOT_MARKER))) {
    throw new Error(
      `${opts.dest} exists and is not a kb-hub snapshot. Point KB_KNOWLEDGE_DIR at an empty or missing folder for hosted mode.`,
    );
  }
  const ref = opts.ref ?? "main";
  const api = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const res = await fetch(`${api}/repos/${opts.repo}/zipball/${encodeURIComponent(ref)}`, {
    headers: {
      authorization: `Bearer ${opts.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "kb-hub",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(
      `GitHub zipball for ${opts.repo}@${ref} failed with ${res.status}. Check KB_GITHUB_REPO and that KB_GITHUB_READ_TOKEN has Contents: read on it.`,
    );
  }
  const zip = new Uint8Array(await res.arrayBuffer());
  if (zip.length > MAX_ZIP_BYTES)
    throw new Error(`knowledge repo zip is over ${MAX_ZIP_BYTES} bytes`);

  const entries = unzipSync(zip, { filter: (f) => f.originalSize <= MAX_FILE_BYTES });
  const next = `${opts.dest}.next`;
  await rm(next, { recursive: true, force: true });
  await mkdir(next, { recursive: true });
  let files = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    // GitHub prefixes every entry with "<owner>-<repo>-<sha>/".
    const rel = name.replace(/\\/g, "/").split("/").slice(1).join("/");
    if (!SERVED.some((p) => rel.startsWith(p))) continue;
    if (rel.split("/").some((p) => p === ".." || p === "." || p === "")) continue;
    const out = join(next, rel);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, bytes);
    files++;
  }
  await writeFile(join(next, SNAPSHOT_MARKER), `${opts.repo}@${ref}\n`);
  const old = `${opts.dest}.old`;
  await rm(old, { recursive: true, force: true });
  await rename(opts.dest, old).catch(() => {});
  await rename(next, opts.dest);
  await rm(old, { recursive: true, force: true });
  return { files, ref, bytes: zip.length };
}
