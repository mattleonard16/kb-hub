import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const fixtureDir = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
export const fixtureText = (name: string) => Bun.file(fixtureDir(name)).text();

/** A writable copy of a fixture knowledge repo in a temp dir. */
export async function tempKnowledge(name = "knowledge-valid"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kb-test-"));
  await cp(fixtureDir(name), dir, { recursive: true });
  return dir;
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kb-test-"));
}

/** Silence console output while running fn. */
export async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}
