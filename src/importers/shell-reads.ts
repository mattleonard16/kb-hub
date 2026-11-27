/**
 * Infers which files a shell command read, for harnesses whose events carry commands but
 * not file reads (Codex). Only plain readers are understood; anything else yields nothing.
 * The result is recorded with source "inferred", never as an observed read.
 */
const READERS = new Set(["cat", "head", "tail", "nl", "less", "more", "wc", "sed", "bat"]);
/** Flags that take a value, so the next word is not a file. */
const VALUE_FLAGS = new Set(["-n", "-c", "-e", "--lines", "--bytes"]);

/** Splits a command into words, honoring single and double quotes. */
function words(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

/** Unwraps `bash -lc '<script>'` and `sh -c "<script>"`. */
function unwrap(cmd: string): string {
  const w = words(cmd);
  const shell = w[0]?.split("/").pop();
  if (
    (shell === "bash" || shell === "sh" || shell === "zsh") &&
    w[1]?.startsWith("-") &&
    w[1].includes("c")
  ) {
    return w[2] ?? "";
  }
  return cmd;
}

export function inferReads(cmd: string): string[] {
  const files: string[] = [];
  for (const part of unwrap(cmd).split(/&&|\|\||;|\|/)) {
    if (part.includes("<<")) continue;
    const w = words(part.trim());
    const bin = w[0]?.split("/").pop();
    if (!bin || !READERS.has(bin)) continue;
    const args = w.slice(1);
    if (bin === "sed") {
      const last = args[args.length - 1];
      if (args.length >= 2 && last && !last.startsWith("-")) files.push(last);
      continue;
    }
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? "";
      if (VALUE_FLAGS.has(a) || /^\d*[<>]{1,2}$/.test(a)) {
        i++;
        continue;
      }
      if (a.startsWith("-") || /^\d+$/.test(a) || a.includes(">") || a.includes("<")) continue;
      files.push(a);
    }
  }
  return files;
}
