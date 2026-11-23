/**
 * Fails if package.json has a dependency that is not on the allowlist.
 * The budget lives in the build plan ("Dependency budget"). Adding a package means:
 * add it here with a one-line reason, note it in AGENTS.md, and get it approved in the PR.
 */
const ALLOWED: Record<string, { kind: "runtime" | "dev"; why: string }> = {
  "@modelcontextprotocol/sdk": { kind: "runtime", why: "MCP protocol and OAuth helpers (M4)" },
  zod: { kind: "runtime", why: "schemas; peer of the MCP SDK" },
  fflate: { kind: "runtime", why: "reading ChatGPT/Claude export ZIPs (M2)" },
  typescript: { kind: "dev", why: "tsc --noEmit type checking" },
  "@biomejs/biome": { kind: "dev", why: "lint and format" },
  "@types/bun": { kind: "dev", why: "types for Bun built-ins" },
};

const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
const problems: string[] = [];

for (const [section, kind] of [
  ["dependencies", "runtime"],
  ["devDependencies", "dev"],
] as const) {
  for (const [name, version] of Object.entries<string>(pkg[section] ?? {})) {
    const entry = ALLOWED[name];
    if (!entry) problems.push(`${name} is not on the allowlist (scripts/check-deps.ts)`);
    else if (entry.kind !== kind)
      problems.push(
        `${name} should be in ${entry.kind === "runtime" ? "dependencies" : "devDependencies"}`,
      );
    if (/^[\^~]|^(latest|\*)$/.test(version))
      problems.push(`${name}@${version} must be pinned to an exact version`);
  }
}
for (const section of ["optionalDependencies", "peerDependencies"]) {
  if (pkg[section] && Object.keys(pkg[section]).length) problems.push(`${section} is not allowed`);
}

if (problems.length) {
  console.error(`Dependency check failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("Dependency check passed.");
