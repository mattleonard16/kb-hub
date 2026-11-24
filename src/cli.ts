#!/usr/bin/env bun
import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { compileAll } from "./compile/compile.ts";
import {
  deliveryStatus,
  pasteFor,
  readState,
  recordDelivery,
  syncTargets,
} from "./compile/sync.ts";
import { writeIndex } from "./compile/wiki-index.ts";
import { coverage } from "./curator/coverage.ts";
import { appendLog, type LogOp, listInbox, markProcessed, staleConcepts } from "./curator/inbox.ts";
import { promote } from "./curator/promote.ts";
import { parseRepoArgs, repoStale } from "./curator/repo-stale.ts";
import { loadKnowledge } from "./index/load.ts";
import { KnowledgeStore } from "./index/store.ts";
import { ingestReply, ingestZip } from "./ingest/ingest.ts";
import { extractionPrompt } from "./ingest/prompts.ts";
import { renderScan, scanRepo } from "./ingest/scan.ts";
import { addSource, isSourceKind, SOURCE_KINDS } from "./ingest/source.ts";
import { FsSink } from "./lib/sinks.ts";
import { lintKnowledge } from "./lint/lint.ts";
import { AuditLog, type Lockdown } from "./mcp/policy.ts";
import { localStateDir } from "./mcp/runtime.ts";
import { Tool } from "./schema/common.ts";

const HELP = `kb — personal knowledge hub

Usage: kb <command> [args] [--json]

Knowledge repo: --dir <path>, or $KB_KNOWLEDGE_DIR, or ../knowledge

Get knowledge in (everything lands in inbox/, the curator's queue)
  add <file|->             Queue any source as-is: email, transcript, notes, repo doc, terminal
                           session, Slack thread, article (--kind <kind> --title "...")
  prompt <tool>            Print the extraction prompt to paste into an AI assistant
  ingest <file|->          Store a pasted extraction reply in inbox/ (--tool <tool>)
  ingest --zip <file>      Store a ChatGPT or Claude data export in inbox/exports/ (--tool <tool>)

Check and search
  lint                     Validate the knowledge repo (schema, links, orphans, index)
  search <words>           Search pages (local, sees everything)
  index                    Regenerate wiki/index.md, the catalog of every page

Serve it to agents
  serve                    MCP over stdio for Claude Code and Codex
  serve --http             Hosted MCP with OAuth (see .env.example)

Deliver it
  compile                  Write build/ (CLAUDE.md and AGENTS.md sections, paste blocks)
  sync [--dry-run]         Update ~/.claude and ~/.codex (marked section + skills)
  paste <tool>             Print the paste block for chatgpt, claude, gemini, muse or instinct
  status                   How many changes behind each tool is

Curate (used by the curator skill)
  init <dir>               Create a new knowledge repo from the template
  inbox                    List unprocessed inbox files (max 200 per run)
  inbox done <paths...>    Move them to raw/ (kept unchanged) and log it (--note "...")
  log <op> --note "..."    Append a log entry (op: ingest, query, lint, promote)
  scan <repo-dir>          Queue a map of a code repo: folders, packages, agent docs, docs catalog
                           (--name <repo>, --exclude <path>, --depth N, --dry-run prints it)
  coverage <repo>          Docs in the repo's latest scan that no page covers yet (--limit N)
  stale [--repo n=<dir>]   Pages past their stale_after date, and with --repo, pages whose
                           repo path changed since their commit
  promote <files...>       Mark concepts verified by you; drafts become stable (--by human:<login>)

Control
  audit [--days N]         What each client read or wrote (default 7 days)
  revoke <client-id>       Block one MCP client immediately
  lockdown <off|read-only|closed>

Tools: ${Tool.options.join(", ")}
Exit codes: 0 ok, 1 check failed, 2 usage error.`;

type Out = { json: boolean };

function print(out: Out, data: unknown, human: string): void {
  console.log(out.json ? JSON.stringify(data, null, 2) : human);
}

class UsageError extends Error {}

function parseTool(v: string | undefined): Tool | undefined {
  if (v === undefined) return undefined;
  const r = Tool.safeParse(v);
  if (!r.success)
    throw new UsageError(`Unknown tool "${v}". Use one of: ${Tool.options.join(", ")}`);
  return r.data;
}

async function controlsFile(): Promise<{
  path: string;
  data: { lockdown?: Lockdown; revoked?: string[] };
}> {
  const path = join(localStateDir(), "controls.json");
  try {
    return { path, data: JSON.parse(await readFile(path, "utf8")) };
  } catch {
    return { path, data: {} };
  }
}

async function saveControls(path: string, data: object): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

export async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      dir: { type: "string" },
      tool: { type: "string" },
      zip: { type: "string" },
      http: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      note: { type: "string" },
      by: { type: "string" },
      days: { type: "string" },
      limit: { type: "string" },
      kind: { type: "string" },
      title: { type: "string" },
      name: { type: "string" },
      exclude: { type: "string", multiple: true },
      depth: { type: "string" },
      repo: { type: "string", multiple: true },
    },
  });
  const out: Out = { json: v.json };
  const [command = "help", ...args] = positionals;
  const root = resolve(
    v.dir ??
      (command === "lint" ? args[0] : undefined) ??
      process.env.KB_KNOWLEDGE_DIR ??
      "../knowledge",
  );

  switch (command) {
    case "help":
      console.log(HELP);
      return 0;

    case "lint": {
      const r = await lintKnowledge(root);
      const errors = r.issues.filter((i) => i.level === "error").length;
      const lines = r.issues.map((i) => `${i.level.padEnd(7)} ${i.file}  [${i.rule}] ${i.message}`);
      lines.push(
        `\n${r.ok ? "ok" : "failed"}: ${r.concepts} concepts, ${r.skills} skills, ${errors} errors, ${r.issues.length - errors} warnings`,
      );
      print(out, r, lines.join("\n"));
      return r.ok ? 0 : 1;
    }

    case "prompt": {
      const tool = parseTool(args[0] ?? v.tool);
      if (!tool) throw new UsageError("Usage: kb prompt <tool>");
      const text = extractionPrompt(tool);
      print(out, { tool, prompt: text }, text);
      return 0;
    }

    case "add": {
      const src = args[0];
      if (!src || !isSourceKind(v.kind))
        throw new UsageError(
          `Usage: kb add <file|-> --kind <${SOURCE_KINDS.join("|")}> [--title "..."]`,
        );
      const text = src === "-" ? await Bun.stdin.text() : await Bun.file(src).text();
      const title = v.title ?? (src === "-" ? v.kind : basename(src).replace(/\.[^.]+$/, ""));
      const ext = src === "-" ? "md" : extname(src).slice(1) || "txt";
      const r = await addSource(new FsSink(root), text, { kind: v.kind, title, ext });
      print(
        out,
        r,
        `${r.created ? "Queued" : "Already queued"} ${r.kind} (${r.bytes} bytes) at ${r.path}.${r.injection.length ? ` It contains instruction-like text (${r.injection.join(", ")}); the curator will not copy it.` : ""}`,
      );
      return 0;
    }

    case "scan": {
      const dir = args[0];
      if (!dir)
        throw new UsageError(
          "Usage: kb scan <repo-dir> [--name <repo>] [--exclude <path>]... [--depth N] [--dry-run]",
        );
      const name = (v.name ?? basename(resolve(dir)))
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[^a-z0-9]+/, "");
      if (!name) throw new UsageError("Give the repo a name with --name");
      const depth = v.depth === undefined ? undefined : Number(v.depth);
      if (depth !== undefined && !(Number.isInteger(depth) && depth > 0))
        throw new UsageError("--depth takes a whole number, 1 or more");
      const scan = await scanRepo(resolve(dir), { name, exclude: v.exclude, depth });
      const text = renderScan(scan);
      if (v["dry-run"]) {
        console.log(out.json ? JSON.stringify(scan, null, 2) : text);
        return 0;
      }
      const r = await addSource(new FsSink(root), text, {
        kind: "repo",
        title: `${name} repo scan`,
      });
      const summary = {
        ...r,
        repo: name,
        commit: scan.commit,
        files: scan.files,
        packages: scan.packages.length,
        docs: scan.docs.length,
      };
      print(
        out,
        summary,
        `${r.created ? "Queued" : "Already queued"} a map of ${name}${scan.commit ? ` at ${scan.commit.slice(0, 7)}` : ""} (${scan.files} files, ${scan.packages.length} packages, ${scan.docs.length} docs) at ${r.path}.`,
      );
      return 0;
    }

    case "coverage": {
      const repo = args[0];
      if (!repo) throw new UsageError("Usage: kb coverage <repo> [--limit N]");
      const r = await coverage(root, repo, (await loadKnowledge(root)).concepts);
      const limit = Number(v.limit ?? 40);
      print(
        out,
        r,
        [
          `${r.repo} at ${r.commit?.slice(0, 7) ?? "no commit"} (${r.scan}): ${r.covered} of ${r.total} docs covered, ${r.skipped} skipped (indexes, logs, plans).`,
          ...r.uncovered.slice(0, limit).map((d) => `  ${d.path}  ${d.title}`),
          r.uncovered.length > limit ? `  ...and ${r.uncovered.length - limit} more` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return 0;
    }

    case "log": {
      const op = args[0];
      if (!op || !["ingest", "query", "lint", "promote"].includes(op) || !v.note)
        throw new UsageError('Usage: kb log <ingest|query|lint|promote> --note "..."');
      await appendLog(root, op as LogOp, v.note, args.slice(1));
      print(out, { op, note: v.note }, `Logged ${op} in wiki/log.md.`);
      return 0;
    }

    case "index": {
      const r = await writeIndex(root, await loadKnowledge(root));
      print(out, r, `Wrote wiki/index.md (${r.pages} pages).`);
      return 0;
    }

    case "ingest": {
      const tool = parseTool(v.tool);
      if (v.zip) {
        if (!tool) throw new UsageError("kb ingest --zip needs --tool chatgpt or --tool claude");
        const r = await ingestZip(root, new Uint8Array(await Bun.file(v.zip).arrayBuffer()), tool);
        print(
          out,
          r,
          `Stored ${r.files.length} file(s) in ${r.dir}${r.conversations !== null ? ` (${r.conversations} conversations)` : ""}.`,
        );
        return 0;
      }
      const src = args[0];
      if (!src) throw new UsageError("Usage: kb ingest <file|-> [--tool <tool>]");
      const text = src === "-" ? await Bun.stdin.text() : await Bun.file(src).text();
      const r = await ingestReply(new FsSink(root), text, {
        tool,
        source: src === "-" ? "stdin" : "file",
      });
      const human = [
        `${r.created ? "Stored" : "Already stored"} ${r.items.length} item(s) from ${r.tool} at ${r.path}.`,
        ...r.errors.map((e) => `  problem: ${e}`),
        ...r.dropped.map((d) => `  dropped: ${d.title} (${d.reason})`),
        ...(r.items.some((i) => i.flags?.length)
          ? ["  some items look like instructions to agents; the curator will review them"]
          : []),
        r.complete
          ? ""
          : "  The reply says it was incomplete. Ask the tool for the rest and ingest that too.",
      ].filter(Boolean);
      print(out, r, human.join("\n"));
      return r.items.length || !r.errors.length ? 0 : 1;
    }

    case "search": {
      const q = args.join(" ");
      if (!q) throw new UsageError("Usage: kb search <words>");
      const store = new KnowledgeStore(await loadKnowledge(root));
      const page = store.search(
        q,
        { allowed: ["public", "personal", "sensitive"] },
        Number(v.limit ?? 8),
      );
      print(
        out,
        page,
        page.results
          .map((r) => `${r.id}  ${r.title}${r.verified ? "" : "  (unverified)"}\n    ${r.snippet}`)
          .join("\n") || "No matches.",
      );
      return 0;
    }

    case "serve": {
      if (v.http) {
        const { serveHttp } = await import("./mcp/serve-http.ts");
        const s = await serveHttp(root);
        console.error(`kb-hub MCP listening on :${s.port} (/mcp/read, /mcp/write)`);
        await new Promise(() => {});
      }
      const { serveStdio } = await import("./mcp/stdio.ts");
      await serveStdio(root, process.env.KB_CLIENT_ID ?? "local");
      await new Promise(() => {});
      return 0;
    }

    case "compile": {
      const k = await loadKnowledge(root);
      const m = await compileAll(root, k);
      const lines = Object.entries(m.outputs).map(
        ([_n, o]) =>
          `${o.file}  ${o.concepts.length} concepts${o.omitted.length ? `, ${o.omitted.length} left out for size` : ""}`,
      );
      if (k.invalid.length)
        lines.push(`skipped invalid files (run kb lint): ${k.invalid.join(", ")}`);
      print(out, m, lines.join("\n"));
      return 0;
    }

    case "sync": {
      const k = await loadKnowledge(root);
      const reports = await syncTargets(k, undefined, { dryRun: v["dry-run"] });
      if (!v["dry-run"]) for (const r of reports) await recordDelivery(r.target, k);
      print(
        out,
        reports,
        reports
          .map(
            (r) =>
              `${r.dryRun ? "[dry run] " : ""}${r.target}: ${r.conceptCount} concepts -> ${r.instructions}; skills ${r.skillsCopied.join(", ") || "none"}${r.skillsSkipped.length ? `; skipped ${r.skillsSkipped.join(", ")}` : ""}`,
          )
          .join("\n"),
      );
      return 0;
    }

    case "paste": {
      const tool = args[0];
      if (!tool) throw new UsageError("Usage: kb paste <chatgpt|claude|gemini|muse|instinct>");
      const k = await loadKnowledge(root);
      const text = pasteFor(tool, k);
      await recordDelivery(tool, k);
      print(out, { tool, text }, text);
      return 0;
    }

    case "status": {
      const s = deliveryStatus(await loadKnowledge(root), await readState());
      print(
        out,
        s,
        s
          .map(
            (t) =>
              `${t.tool.padEnd(12)} ${t.changes_behind ? `${t.changes_behind} change(s) behind` : "up to date"}${t.last_delivered ? `  (last ${t.last_delivered.slice(0, 10)})` : "  (never delivered)"}`,
          )
          .join("\n"),
      );
      return 0;
    }

    case "init": {
      const dest = resolve(args[0] ?? "");
      if (!args[0]) throw new UsageError("Usage: kb init <dir>");
      const existing = await readdir(dest).catch(() => []);
      if (existing.length) throw new UsageError(`${dest} is not empty`);
      await cp(new URL("../templates/knowledge/", import.meta.url).pathname, dest, {
        recursive: true,
      });
      await rename(join(dest, "gitignore.txt"), join(dest, ".gitignore"));
      await writeIndex(dest, await loadKnowledge(dest));
      print(
        out,
        { created: dest },
        `Created a knowledge repo at ${dest}. Next: git init, push it as a private repo, and set KB_KNOWLEDGE_DIR=${dest}.`,
      );
      return 0;
    }

    case "inbox": {
      if (args[0] === "done") {
        const paths = args.slice(1);
        if (!paths.length || !v.note)
          throw new UsageError('Usage: kb inbox done <paths...> --note "summary"');
        const moved = await markProcessed(root, paths, v.note);
        print(
          out,
          { moved },
          `Moved ${moved.length} file(s) to raw/ and logged the ingest in wiki/log.md.`,
        );
        return 0;
      }
      const r = await listInbox(root, Number(v.limit ?? 200));
      print(
        out,
        r,
        r.entries
          .map(
            (e) =>
              `${e.kind.padEnd(10)} ${e.path}${e.suspicious ? "  (suspicious: review, do not promote)" : ""}`,
          )
          .join("\n") + (r.remaining ? `\n${r.remaining} more carry over to the next run.` : "") ||
          "Inbox is empty.",
      );
      return 0;
    }

    case "stale": {
      const { concepts } = await loadKnowledge(root);
      const s = staleConcepts(concepts);
      let repos: Map<string, string>;
      try {
        repos = parseRepoArgs(v.repo ?? []);
      } catch (e) {
        throw new UsageError((e as Error).message);
      }
      const changed = repoStale(concepts, repos);
      const lines = [
        ...s.map((c) => `${c.id}  ${c.title}  (stale since ${c.stale_after})`),
        ...changed.map((c) => `${c.id}  ${c.title}  (${c.reason})`),
      ];
      print(out, { dates: s, repos: changed }, lines.join("\n") || "Nothing is stale.");
      return 0;
    }

    case "promote": {
      if (!args.length || !v.by)
        throw new UsageError("Usage: kb promote <files...> --by human:<login>");
      const r = await promote(args, v.by);
      if (r.length)
        await appendLog(
          root,
          "promote",
          `${r.length} page(s) approved by ${v.by}`,
          r.map((x) => `${x.file.replace(/^.*?wiki\//, "")}: ${x.from} -> ${x.to}`),
        );
      print(
        out,
        r,
        r.map((x) => `${x.file}: ${x.from} -> ${x.to}, verified`).join("\n") ||
          "Nothing to promote.",
      );
      return 0;
    }

    case "audit": {
      const days = Number(v.days ?? 7);
      const since = Date.now() - days * 86_400_000;
      const entries = (await new AuditLog(join(localStateDir(), "audit.jsonl")).read()).filter(
        (e) => Date.parse(e.at) >= since,
      );
      const byClient = new Map<
        string,
        { calls: number; writes: number; denied: number; concepts: Set<string> }
      >();
      for (const e of entries) {
        const s = byClient.get(e.client) ?? {
          calls: 0,
          writes: 0,
          denied: 0,
          concepts: new Set<string>(),
        };
        s.calls++;
        if (e.tool === "flag_knowledge" || e.tool === "ingest") s.writes++;
        if (!e.ok) s.denied++;
        for (const id of e.concept_ids ?? []) s.concepts.add(id);
        byClient.set(e.client, s);
      }
      const summary = [...byClient].map(([client, s]) => ({
        client,
        calls: s.calls,
        writes: s.writes,
        failed: s.denied,
        concepts_read: s.concepts.size,
      }));
      print(
        out,
        { days, summary },
        summary
          .map(
            (s) =>
              `${s.client}: ${s.calls} calls, ${s.writes} writes, ${s.failed} failed, ${s.concepts_read} distinct concepts`,
          )
          .join("\n") || `No MCP calls in the last ${days} days.`,
      );
      return 0;
    }

    case "revoke": {
      const id = args[0];
      if (!id) throw new UsageError("Usage: kb revoke <client-id> (see kb audit for ids)");
      const c = await controlsFile();
      c.data.revoked = [...new Set([...(c.data.revoked ?? []), id])];
      await saveControls(c.path, c.data);
      print(out, c.data, `Revoked ${id}. For the hosted server also add it to KB_REVOKED_CLIENTS.`);
      return 0;
    }

    case "lockdown": {
      const mode = args[0] as Lockdown | undefined;
      if (!mode || !["off", "read-only", "closed"].includes(mode))
        throw new UsageError("Usage: kb lockdown <off|read-only|closed>");
      const c = await controlsFile();
      c.data.lockdown = mode;
      await saveControls(c.path, c.data);
      print(
        out,
        c.data,
        `Lockdown is now ${mode}. For the hosted server also set KB_LOCKDOWN=${mode}.`,
      );
      return 0;
    }

    default:
      throw new UsageError(`Unknown command "${command}". Run kb help to see commands.`);
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(Bun.argv.slice(2)));
  } catch (err) {
    const usage =
      err instanceof UsageError || (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    console.error((err as Error).message);
    process.exit(usage ? 2 : 1);
  }
}
