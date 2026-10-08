import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// core/backend-architecture: unique versions, immutable applied history, separately reviewed destructive SQL.
const directory = "supabase/migrations";
// Data-destroying or client-breaking statements; function renames/constraint drops are routine here.
const destructive =
  /\bdrop\s+(?:table|schema|column)\b|\btruncate\b|\balter\s+table\b[^;]*?\b(?:rename|alter\s+column\s+\S+\s+(?:set\s+data\s+)?type)\b|\bdelete\s+from\b(?![^;]*\bwhere\b)/i;
const reviewed = /^--\s*destructive-reviewed:\s*\S/m;

export function migrationProblems(
  files: string[],
  changes: { status: string; path: string }[],
  read: (path: string) => string,
): string[] {
  const problems: string[] = [];
  const versions = new Map<string, string>();
  for (const file of files.filter((name) => name.endsWith(".sql"))) {
    const version = file.split("_")[0] ?? "";
    if (!/^\d{14}$/.test(version))
      problems.push(`${file}: name must start with a 14-digit version`);
    else if (versions.has(version))
      problems.push(`${file}: duplicate version ${version} (also ${versions.get(version)})`);
    else versions.set(version, file);
  }
  for (const { status, path } of changes) {
    if (!path.endsWith(".sql")) continue;
    if (status !== "A") {
      problems.push(`${path}: applied migrations are immutable (status ${status}); add a new one`);
      continue;
    }
    // Comments may legitimately mention destructive keywords; only statements count.
    const sql = read(path);
    const code = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (destructive.test(code) && !reviewed.test(sql))
      problems.push(
        `${path}: destructive SQL (drop table/schema/column, truncate, table rename/retype, unbounded delete) needs a "-- destructive-reviewed: <reason>" line`,
      );
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // CI checks out the merge commit, whose first parent is the base; locally pass origin/main.
  const base = process.argv[2] ?? "HEAD^1";
  const changes = execFileSync(
    "git",
    ["diff", "--name-status", "--no-renames", base, "HEAD", "--", directory],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", path = ""] = line.split("\t");
      return { status: status.charAt(0), path };
    });
  const problems = migrationProblems(readdirSync(directory), changes, (path) =>
    readFileSync(path, "utf8"),
  );
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  if (problems.length) process.exitCode = 1;
  else process.stdout.write(`Migrations verified against ${base}: ${changes.length} changed.\n`);
}
