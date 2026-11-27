/**
 * Stops with a clear message when Bun is older than the version this repo pins.
 * An older Bun can't read bun.lock: it silently re-resolves and rewrites it, and CI's
 * `bun install --frozen-lockfile` then fails.
 */
const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
const pinned = String(pkg.packageManager ?? "").replace(/^bun@/, "");

const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
const older = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
};

if (pinned && older(Bun.version, pinned)) {
  console.error(
    `This repo needs Bun ${pinned} or newer, and you have ${Bun.version}.\n` +
      "Run `bun upgrade`, then `git checkout bun.lock` if an older Bun rewrote it, then `bun install`.",
  );
  process.exit(1);
}
