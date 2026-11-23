import { shortHash, today, writeInbox } from "./inbox.ts";

/**
 * Where agent writes go. Locally: files in <knowledge>/inbox/. Hosted: a commit on the
 * knowledge repo's `inbox` branch through the GitHub API, so the server keeps no state.
 * Either way nothing lands in wiki/ without a reviewed PR.
 */
export interface InboxSink {
  put(relPath: string, content: string): Promise<{ path: string; created: boolean }>;
}

export class FsSink implements InboxSink {
  constructor(private root: string) {}
  put(relPath: string, content: string) {
    return writeInbox(this.root, relPath, content);
  }
}

export class GitHubSink implements InboxSink {
  constructor(
    private repo: string,
    private token: string,
    private branch = "inbox",
    private api = "https://api.github.com",
  ) {}

  async put(relPath: string, content: string) {
    if (relPath.split("/").some((p) => p === ".." || p === ""))
      throw new Error(`bad inbox path: ${relPath}`);
    const path = `inbox/${relPath}`;
    const headers = {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
    const url = `${this.api}/repos/${this.repo}/contents/${path}`;
    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `inbox: ${relPath}`,
        content: Buffer.from(content).toString("base64"),
        branch: this.branch,
      }),
    });
    if (res.status === 422) return { path, created: false }; // already exists: idempotent retry
    if (!res.ok)
      throw new Error(`GitHub write failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return { path, created: true };
  }
}

export function flagPath(
  clientId: string,
  content: string,
  idempotencyKey?: string,
  now = new Date(),
): string {
  const key = idempotencyKey ? shortHash(`${clientId}|${idempotencyKey}`) : shortHash(content);
  const safeClient = clientId.replace(/[^a-z0-9-]/gi, "-").slice(0, 40);
  return `flags/${today(now)}-${safeClient}-${key}.yaml`;
}
