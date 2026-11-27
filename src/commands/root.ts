import { type Ctx, UsageError } from "../lib/context.ts";
import { repoRoot } from "../lib/git.ts";

/** The git repo the command runs in. Baton only works inside one. */
export function requireRoot(ctx: Ctx): string {
  const root = repoRoot(ctx.cwd);
  if (!root) throw new UsageError("not inside a git repository");
  return root;
}
