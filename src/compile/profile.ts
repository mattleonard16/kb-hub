import type { Knowledge } from "../index/load.ts";
import type { Sensitivity } from "../schema/concept.ts";
import { profileSection } from "./compile.ts";

/** The always-on profile as an MCP resource, limited to what this caller may see. */
export function compileProfile(k: Knowledge, allowed: Sensitivity[]): string {
  const visible = {
    ...k,
    concepts: k.concepts.filter((c) => allowed.includes(c.meta.sensitivity)),
  };
  return profileSection(visible, 300).text;
}
