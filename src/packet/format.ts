import { FIELD_ORDER } from "./schema.ts";

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export type ParsedPacket =
  | { ok: true; data: Record<string, unknown>; body: string }
  | { ok: false; error: string };

/** Splits a packet file into YAML frontmatter and Markdown body (Bun's built-in YAML). */
export function parsePacketText(text: string): ParsedPacket {
  const match = FENCE.exec(text);
  if (!match) return { ok: false, error: "missing YAML frontmatter (file must start with ---)" };
  const [, yaml = "", body = ""] = match;
  try {
    const data = Bun.YAML.parse(yaml);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "frontmatter must be a YAML mapping" };
    }
    return { ok: true, data: data as Record<string, unknown>, body };
  } catch (err) {
    return { ok: false, error: `invalid YAML: ${(err as Error).message}` };
  }
}

/** Writes frontmatter in a fixed field order, dropping empty optional values. */
export function formatPacket(data: Record<string, unknown>, body: string): string {
  const ordered: Record<string, unknown> = {};
  const keys = [
    ...FIELD_ORDER,
    ...Object.keys(data).filter((k) => !FIELD_ORDER.includes(k as never)),
  ];
  for (const key of keys) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0 && key !== "files_touched") continue;
    ordered[key] = value;
  }
  const yaml = Bun.YAML.stringify(ordered, null, 2).replace(/\n*$/, "\n");
  const cleanBody = body.replace(/^\n+/, "");
  return `---\n${yaml}---\n\n${cleanBody.replace(/\n*$/, "\n")}`;
}

export const CHANGES_START = "<!-- baton:changes -->";
export const CHANGES_END = "<!-- /baton:changes -->";

/** Removes the generated "Changes since the last revision" block from a body. */
export function stripChanges(body: string): string {
  const start = body.indexOf(CHANGES_START);
  const end = body.indexOf(CHANGES_END);
  if (start === -1 || end === -1 || end < start) return body;
  return (body.slice(0, start) + body.slice(end + CHANGES_END.length)).replace(/^\n+/, "");
}
