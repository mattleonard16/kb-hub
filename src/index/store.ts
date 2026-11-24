import { Database } from "bun:sqlite";
import { type LinkGraph, linkGraph } from "../lib/links.ts";
import type { Sensitivity, Status } from "../schema/concept.ts";
import type { Concept, Knowledge } from "./load.ts";

export type SearchFilters = {
  scope?: string;
  type?: string;
  includeDeprecated?: boolean;
  /** Sensitivity levels this caller may see. */
  allowed: Sensitivity[];
};

export type SearchHit = {
  id: string;
  title: string;
  description: string | null;
  type: string;
  scope: string;
  status: Status;
  verified: boolean;
  snippet: string;
  last_updated: string;
};

export type SearchPage = { results: SearchHit[]; next_cursor: string | null; total: number };

/** Question and filler words dropped from searches (porter also stems "use" to "us", etc.). */
const STOPWORDS = new Set(
  (
    "a an and are as at be by can do does for from has have how i in is it its me my of on or " +
    "should so that the their there this to us use used using was what when where which who why " +
    "will with would you your"
  ).split(" "),
);

/**
 * In-memory SQLite FTS5 index over a loaded knowledge repo. Rebuilt from the repo in
 * milliseconds, so it is never the source of truth and never needs migrations.
 */
export class KnowledgeStore {
  readonly db: Database;
  readonly graph: LinkGraph;
  private byId = new Map<string, Concept>();

  constructor(readonly knowledge: Knowledge) {
    this.graph = linkGraph(knowledge.concepts);
    this.db = new Database(":memory:");
    this.db.run(`CREATE TABLE concepts (
      id TEXT PRIMARY KEY, title TEXT, description TEXT, type TEXT, scope TEXT,
      status TEXT, sensitivity TEXT, verified INTEGER, last_updated TEXT, resource TEXT)`);
    this.db.run(`CREATE VIRTUAL TABLE concepts_fts USING fts5(
      id UNINDEXED, title, description, body, tags, tokenize = 'porter unicode61')`);
    const ins = this.db.prepare("INSERT INTO concepts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const fts = this.db.prepare("INSERT INTO concepts_fts VALUES (?, ?, ?, ?, ?)");
    this.db.transaction(() => {
      for (const c of knowledge.concepts) {
        this.byId.set(c.id, c);
        const verified = c.meta.verified?.some((v) => v.by.startsWith("human:")) ? 1 : 0;
        ins.run(
          c.id,
          c.meta.title,
          c.meta.description ?? null,
          c.meta.type,
          c.meta.scope,
          c.meta.status,
          c.meta.sensitivity,
          verified,
          c.lastUpdated,
          c.meta.repo && c.meta.resource ? c.meta.resource.replace(/^\.\/|\/+$/g, "") : null,
        );
        fts.run(
          c.id,
          c.meta.title,
          c.meta.description ?? "",
          c.body,
          // Lessons are found by their symptoms, and code pages by their path.
          [
            ...(c.meta.tags ?? []),
            ...(c.meta.applies_when ?? []),
            ...(c.meta.symptoms ?? []),
            c.meta.repo ?? "",
            c.meta.resource ?? "",
          ].join(" "),
        );
      }
    })();
  }

  get size(): number {
    return this.byId.size;
  }

  /** Get one concept if the caller may see it. */
  get(id: string, allowed: Sensitivity[]): Concept | null {
    const c = this.byId.get(id);
    return c && allowed.includes(c.meta.sensitivity) ? c : null;
  }

  /** Pages this page links to and pages that link to it, limited to what the caller may see. */
  related(id: string, allowed: Sensitivity[]): { links: string[]; backlinks: string[] } {
    const visible = (x: string) => this.get(x, allowed) !== null;
    return {
      links: (this.graph.links.get(id) ?? []).filter(visible),
      backlinks: (this.graph.backlinks.get(id) ?? []).filter(visible),
    };
  }

  /** Ids that look like `id`, for "did you mean" errors. */
  similarIds(id: string, allowed: Sensitivity[], limit = 3): string[] {
    const words = id.split(/[^a-z0-9]+/i).filter((w) => w.length > 1);
    if (!words.length) return [];
    return this.search(words.join(" "), { allowed }, limit).results.map((r) => r.id);
  }

  search(query: string, f: SearchFilters, limit = 8, cursor?: string | null): SearchPage {
    const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    // Agents search in full questions; filler words would match almost every concept.
    const content = words.filter((w) => !STOPWORDS.has(w));
    const terms = content.length ? content : words;
    if (!terms.length) return { results: [], next_cursor: null, total: 0 };
    const match = terms.map((t) => `"${t}"*`).join(" OR ");
    const offset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);

    const where: string[] = ["concepts_fts MATCH $match"];
    const params: Record<string, string | number> = { $match: match };
    where.push(`c.sensitivity IN (${f.allowed.map((_, i) => `$s${i}`).join(", ") || "''"})`);
    f.allowed.forEach((s, i) => {
      params[`$s${i}`] = s;
    });
    if (!f.includeDeprecated) where.push("c.status != 'deprecated'");
    if (f.scope) {
      where.push("c.scope = $scope");
      params.$scope = f.scope;
    }
    if (f.type) {
      where.push("c.type = $type");
      params.$type = f.type;
    }
    // Pages that match more of the words come first, then BM25. Without this, a question's
    // single most common word can outrank the one page that matches all of it.
    const covers = terms.map((t, i) => {
      params[`$t${i}`] = `"${t}"*`;
      return `(c.id IN (SELECT id FROM concepts_fts WHERE concepts_fts MATCH $t${i}))`;
    });
    // A path asks "what is this code": the page whose resource is that path, or the closest folder
    // above it, comes first.
    const path = /^[\w.@[\]-]+(\/[\w.@[\]-]+)+\/?$/.test(query.trim())
      ? query.trim().replace(/^\.\/|\/+$/g, "")
      : null;
    params.$path = path ?? "";
    const pathRank = path
      ? "CASE WHEN c.resource = $path OR $path LIKE c.resource || '/%' THEN length(c.resource) ELSE 0 END DESC, "
      : "";
    const sql = `FROM concepts_fts JOIN concepts c ON c.id = concepts_fts.id WHERE ${where.join(" AND ")}`;
    const total = (this.db.query(`SELECT count(*) AS n ${sql}`).get(params) as { n: number }).n;
    const rows = this.db
      .query(
        `SELECT c.*, snippet(concepts_fts, 3, '', '', ' … ', 16) AS snippet ${sql}
         ORDER BY ${pathRank}(${covers.join(" + ")}) DESC, bm25(concepts_fts, 0, 8.0, 3.0, 1.0, 2.0) - c.verified * 0.5
         LIMIT $limit OFFSET $offset`,
      )
      .all({ ...params, $limit: limit, $offset: offset }) as Array<Record<string, unknown>>;
    const results = rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      description: (r.description as string | null) ?? null,
      type: String(r.type),
      scope: String(r.scope),
      status: r.status as Status,
      verified: r.verified === 1,
      snippet: String(r.snippet ?? ""),
      last_updated: String(r.last_updated),
    }));
    const next = offset + results.length;
    return { results, next_cursor: next < total ? String(next) : null, total };
  }
}
