import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const root = await realpath(".");
const hash = createHash("sha256").update(root).digest("hex");
const portBase = (path: string) =>
  20000 + (parseInt(createHash("sha256").update(path).digest("hex").slice(0, 6), 16) % 3000) * 10;
const base = portBase(root);
const action = process.argv[2] || "info";
// ponytail: reject hash collisions within this repository; services reject occupied OS ports.
if (action !== "stop") {
  const worktrees = spawnSync("git", ["worktree", "list", "--porcelain", "-z"], {
    encoding: "utf8",
  });
  if (worktrees.error) throw worktrees.error;
  if (worktrees.status !== 0) throw new Error(worktrees.stderr || "Cannot inspect Git worktrees");
  for (const field of worktrees.stdout.split("\0")) {
    if (!field.startsWith("worktree ")) continue;
    let path: string;
    try {
      path = await realpath(field.slice(9));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (path !== root && portBase(path) === base)
      throw new Error(
        `Port block ${base}-${base + 9} collides with ${path}. Move/recreate this worktree at a different path, then rerun bootstrap. Use db:stop before moving a running stack.`,
      );
  }
}
const workdir = join(root, ".local", hash.slice(0, 8));
await mkdir(join(workdir, "supabase"), { recursive: true });
let config = await readFile("supabase/config.toml", "utf8");
config = config.replace(/^project_id\s*=.*$/m, `project_id = "crm-${hash.slice(0, 8)}"`);
const ports: Record<string, Record<string, number | string>> = {
  api: { port: base },
  db: { port: base + 1, shadow_port: base + 7 },
  studio: { port: base + 2, api_url: `http://127.0.0.1:${base}` },
  inbucket: { port: base + 3 },
  "db.pooler": { port: base + 8 },
  analytics: { port: base + 6 },
  edge_runtime: { inspector_port: base + 5 },
  auth: {
    site_url: `http://127.0.0.1:${base + 4}`,
    additional_redirect_urls: `["http://127.0.0.1:${base + 4}/**"]`,
  },
};
const sectionPattern = (section: string) =>
  new RegExp(
    `(^\\[${section.replaceAll(".", "\\.")}\\]\\r?\\n)([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`,
    "m",
  );
const setting = (key: string, value: number | string) =>
  `${key} = ${typeof value === "number" || key === "additional_redirect_urls" ? value : JSON.stringify(value)}`;
for (const [section, entries] of Object.entries(ports)) {
  // Missing sections/keys would silently keep CLI default ports shared by every worktree.
  if (!sectionPattern(section).test(config)) config = `${config.trimEnd()}\n[${section}]\n`;
  config = config.replace(sectionPattern(section), (_match, heading: string, body: string) => {
    for (const [key, value] of Object.entries(entries)) {
      const line = new RegExp(`^${key}\\s*=\\s*(?:\\[[\\s\\S]*?\\]|[^\\r\\n]*)`, "m");
      body = line.test(body)
        ? body.replace(line, setting(key, value))
        : `${setting(key, value)}\n${body}`;
    }
    return heading + body;
  });
}
await writeFile(join(workdir, "supabase/config.toml"), config);
for (const item of ["migrations", "functions", "tests"]) {
  try {
    await symlink(join(root, "supabase", item), join(workdir, "supabase", item), "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
// Edge functions import ../../../packages/contracts/src. Served functions run in a container that
// cannot follow a symlink back into the checkout, so copy the contract sources (fresh each run).
await rm(join(workdir, "packages"), { recursive: true, force: true });
await cp(join(root, "packages/contracts/src"), join(workdir, "packages/contracts/src"), {
  recursive: true,
});
if (
  !config.includes(`project_id = "crm-${hash.slice(0, 8)}"`) ||
  Object.entries(ports).some(([section, entries]) =>
    Object.entries(entries).some(
      ([key, value]) => !sectionPattern(section).exec(config)?.[2]?.includes(setting(key, value)),
    ),
  )
)
  throw new Error("Local Supabase identity/port isolation failed");
if (action === "info") {
  console.log(
    JSON.stringify(
      {
        project_id: `crm-${hash.slice(0, 8)}`,
        web_port: base + 4,
        api_url: `http://127.0.0.1:${base}`,
        db_port: base + 1,
        workdir,
      },
      null,
      2,
    ),
  );
} else if (action === "dev") {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@crm/web",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(base + 4),
      "--strictPort",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else if (action === "edge-test") {
  const result = spawnSync(
    "deno",
    [
      "test",
      "--frozen",
      "--allow-env",
      "--allow-net",
      "--allow-run",
      "--allow-read",
      "--config",
      "supabase/functions/deno.json",
      // Deno collects every *.test.ts here, so new Edge test files cannot be skipped.
      "supabase/tests",
    ],
    { stdio: "inherit", env: { ...process.env, SUPABASE_WORKDIR: workdir } },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  const args: Record<string, string[]> = {
    start: ["start", "-x", "logflare,vector"],
    reset: ["db", "reset"],
    test: ["test", "db"],
    stop: ["stop"],
    types: ["gen", "types", "typescript", "--local"],
    // Serving through local.ts re-copies the contract sources first (see above); functions stay
    // symlinked and reload live, but restart serve after editing packages/contracts/src.
    serve: ["functions", "serve", ...process.argv.slice(3)],
  };
  if (!Object.hasOwn(args, action))
    throw new Error("Use info, start, reset, test, stop, types, serve, dev or edge-test");
  if (action === "start" && spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0)
    throw new Error("Docker is unavailable. Start Docker/Colima, then retry pnpm db:start.");
  const result = spawnSync(
    "pnpm",
    ["exec", "supabase", "--workdir", workdir, ...(args[action] ?? [])],
    {
      stdio: action === "types" ? ["inherit", "pipe", "inherit"] : "inherit",
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  // CLI 2.119+ prints types unformatted; CI diffs this output against database.ts.
  // The stdin path must stay outside .oxfmtrc.json ignorePatterns or oxfmt passes it through.
  if (action === "types" && result.status === 0) {
    const formatted = spawnSync("pnpm", ["exec", "oxfmt", "--stdin-filepath=types.ts"], {
      input: result.stdout,
      stdio: ["pipe", "inherit", "inherit"],
    });
    if (formatted.error) throw formatted.error;
    process.exitCode = formatted.status ?? 1;
  }
}
