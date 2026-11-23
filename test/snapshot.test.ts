import { describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";
import { loadKnowledge } from "../src/index/load.ts";
import { fetchSnapshot, SNAPSHOT_MARKER } from "../src/mcp/snapshot.ts";
import { fixtureDir, tempDir } from "./helpers.ts";

/** A zipball shaped like GitHub's: every entry under "<owner>-<repo>-<sha>/". */
async function fixtureZip(extra: Record<string, string> = {}): Promise<Uint8Array> {
  const src = fixtureDir("knowledge-valid");
  const files: Record<string, Uint8Array> = {};
  const add = async (dir: string) => {
    for (const e of await readdir(join(src, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) await add(rel);
      else files[`me-knowledge-abc123/${rel}`] = new Uint8Array(await readFile(join(src, rel)));
    }
  };
  await add("");
  for (const [k, v] of Object.entries(extra)) files[k] = new TextEncoder().encode(v);
  return zipSync(files);
}

function fakeGitHub(zip: () => Uint8Array, status = 200) {
  const seen: Array<{ path: string; auth: string | null }> = [];
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    fetch(req): Response {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, auth: req.headers.get("authorization") });
      if (url.pathname.startsWith("/repos/")) {
        // GitHub answers with a redirect to codeload; follow it the same way.
        return Response.redirect(`http://localhost:${server.port}/codeload/x.zip`, 302);
      }
      if (status !== 200) return new Response("nope", { status });
      return new Response(zip());
    },
  });
  return { server, seen, api: `http://localhost:${server.port}` };
}

describe("knowledge snapshot from a GitHub zipball", () => {
  test("unpacks only wiki/ and skills/, and the result loads", async () => {
    const zip = await fixtureZip({
      "me-knowledge-abc123/inbox/flags/x.yaml": "kind: missing\n",
      "me-knowledge-abc123/.github/workflows/k.yml": "on: push\n",
    });
    const gh = fakeGitHub(() => zip);
    try {
      const dest = join(await tempDir(), "kb");
      const r = await fetchSnapshot({ repo: "me/knowledge", token: "tok", dest, apiBase: gh.api });
      expect(r.ref).toBe("main");
      expect(gh.seen[0]).toEqual({ path: "/repos/me/knowledge/zipball/main", auth: "Bearer tok" });
      expect((await readdir(dest)).sort()).toEqual([SNAPSHOT_MARKER, "skills", "wiki"]);
      const k = await loadKnowledge(dest);
      expect(k.concepts.length).toBe(7);
      expect(k.skills.length).toBe(1);

      // A second fetch (the webhook) swaps in the new copy.
      await fetchSnapshot({ repo: "me/knowledge", token: "tok", dest, apiBase: gh.api });
      expect((await loadKnowledge(dest)).concepts.length).toBe(7);
    } finally {
      gh.server.stop();
    }
  });

  test("never replaces a folder it did not create, and keeps the old copy on failure", async () => {
    const zip = await fixtureZip();
    const ok = fakeGitHub(() => zip);
    const bad = fakeGitHub(() => zip, 404);
    try {
      const checkout = await tempDir();
      await writeFile(join(checkout, "notes.md"), "mine");
      await expect(
        fetchSnapshot({ repo: "me/knowledge", token: "t", dest: checkout, apiBase: ok.api }),
      ).rejects.toThrow("not a kb-hub snapshot");
      expect(await readFile(join(checkout, "notes.md"), "utf8")).toBe("mine");

      const dest = join(await tempDir(), "kb");
      await fetchSnapshot({ repo: "me/knowledge", token: "t", dest, apiBase: ok.api });
      await expect(
        fetchSnapshot({ repo: "me/knowledge", token: "t", dest, apiBase: bad.api }),
      ).rejects.toThrow("failed with 404");
      expect((await loadKnowledge(dest)).concepts.length).toBe(7);
      await expect(
        fetchSnapshot({ repo: "../evil", token: "t", dest, apiBase: ok.api }),
      ).rejects.toThrow("bad repo name");
    } finally {
      ok.server.stop();
      bad.server.stop();
    }
  });
});
