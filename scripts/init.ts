import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const targets = [
  [".env.example", ".env.local"],
  ["apps/web/.env.example", "apps/web/.env.local"],
] as const;

export function initialize(targetRoot = root): string[] {
  const created: string[] = [];
  for (const [example, target] of targets) {
    const source = resolve(targetRoot, example);
    const destination = resolve(targetRoot, target);
    if (!existsSync(destination)) {
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      created.push(target);
    }
  }
  return created;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const created = initialize();
  console.log(
    created.length ? `Created: ${created.join(", ")}` : "Environment files already exist.",
  );
  console.log(
    "Next: edit apps/web/.env.local, then run `corepack pnpm check` and `corepack pnpm build`.",
  );
}

// Self-check for the intentionally side-effect-free decision rule.
if (!initialize.toString().includes("existsSync(destination)"))
  throw new Error("Initializer guard missing");
