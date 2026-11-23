import base from "../../prompts/extract/base.md" with { type: "text" };
import chatgpt from "../../prompts/extract/chatgpt.md" with { type: "text" };
import claude from "../../prompts/extract/claude.md" with { type: "text" };
import claudeCode from "../../prompts/extract/claude-code.md" with { type: "text" };
import codex from "../../prompts/extract/codex.md" with { type: "text" };
import dots from "../../prompts/extract/dots.md" with { type: "text" };
import duet from "../../prompts/extract/duet.md" with { type: "text" };
import gemini from "../../prompts/extract/gemini.md" with { type: "text" };
import instinct from "../../prompts/extract/instinct.md" with { type: "text" };
import muse from "../../prompts/extract/muse.md" with { type: "text" };
import { today } from "../lib/inbox.ts";
import type { Tool } from "../schema/common.ts";

/** Text imports so the prompts are bundled into the compiled `kb` binary. */
const TAILS: Record<Tool, string> = {
  "claude-code": claudeCode,
  codex,
  chatgpt,
  gemini,
  claude,
  muse,
  instinct,
  dots,
  duet,
};

export const PROMPT_VERSION = 1;

/** The full paste-in extraction prompt for one tool: base prompt plus that tool's tail. */
export function extractionPrompt(tool: Tool, now = new Date()): string {
  const head = base.replaceAll("{{TOOL}}", tool).replaceAll("{{TODAY}}", today(now)).trimEnd();
  return `${head}\n\n${TAILS[tool].trim()}\n`;
}
