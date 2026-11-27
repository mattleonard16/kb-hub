/** A line diff from the longest common subsequence. Packets are small, so O(n*m) is fine. */
export type DiffLine = { op: " " | "-" | "+"; line: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const next = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", line: a[i] ?? "" });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push({ op: "-", line: a[i++] ?? "" });
    } else {
      out.push({ op: "+", line: b[j++] ?? "" });
    }
  }
  while (i < n) out.push({ op: "-", line: a[i++] ?? "" });
  while (j < m) out.push({ op: "+", line: b[j++] ?? "" });
  return out;
}

/** Only the changed lines, as "- old" / "+ new". Empty when nothing changed. */
export function changedLines(before: string, after: string): string[] {
  return diffLines(before, after)
    .filter((d) => d.op !== " " && d.line.trim() !== "")
    .map((d) => `${d.op} ${d.line}`);
}
