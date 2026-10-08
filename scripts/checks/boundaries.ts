import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { isBuiltin } from "node:module";
import ts from "typescript-api";
// Edge isolation lives here: supabase/functions is a Deno tree, not a turbo workspace package.
function forbidden(file: string, source: string) {
  file = file.replaceAll("\\", "/");
  const specifier = source.replaceAll("\\", "/");
  const normalized = specifier.startsWith(".")
    ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    : specifier;
  if (file.startsWith("packages/contracts/")) {
    if (/apps\/|supabase\//.test(normalized)) return true;
    // Contracts stay runtime-neutral; node:test/assert are allowed in their own tests only.
    const runtime =
      /^(?:react|react-dom)(?:\/|$)|^(?:node|deno|npm|jsr|https?):/.test(normalized) ||
      isBuiltin(normalized);
    if (runtime && !(/\.test\.[^.]+$/.test(file) && normalized.startsWith("node:"))) return true;
  }
  if (file.startsWith("apps/web/") && /supabase\/functions|packages\/[^/]+\/src/.test(normalized))
    return true;
  if (file.startsWith("supabase/functions/") && /apps\/web/.test(normalized)) return true;
  const screenName = (value: string) =>
    // A screen's own helpers and styles (Settings.helpers.ts, settings.css) belong to it.
    value
      .match(/^apps\/web\/src\/screens\/([^/]+)/)?.[1]
      ?.replace(/\..*$/, "")
      .toLowerCase();
  const screen = screenName(file);
  const imported = screenName(normalized);
  return Boolean(screen && imported && screen !== imported);
}
function imports(file: string, source: string) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const sources: string[] = [];
  function visit(node: ts.Node) {
    const value =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isExternalModuleReference(node)
          ? node.expression
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                  (ts.isIdentifier(node.expression) && node.expression.text === "require"))
              ? node.arguments[0]
              : undefined;
    if (value && ts.isStringLiteralLike(value)) sources.push(value.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return sources;
}
assert.equal(forbidden("apps/web/src/test.ts", "../../supabase/functions/mcp/index.ts"), true);
assert.equal(forbidden("supabase/functions/test.ts", "@crm/contracts"), false);
assert.equal(forbidden("packages/contracts/src/domain.ts", "react"), true);
assert.equal(forbidden("apps/web/src/screens/Settings.tsx", "./Notifications"), true);
assert.equal(forbidden("apps/web/src/screens/JobDetail.tsx", "../screens/Notifications.tsx"), true);
assert.equal(forbidden("apps/web/src/screens/jobs/List.tsx", "../contacts/Detail"), true);
assert.equal(forbidden("apps/web/src/screens/jobs/List.tsx", "./Detail"), false);
assert.equal(forbidden("apps/web/src/screens/Settings.tsx", "../shared/notifications"), false);
assert.equal(forbidden("apps/web/src/screens/Settings.tsx", "./Settings.helpers.ts"), false);
assert.equal(forbidden("apps/web/src/screens/Settings.tsx", "./settings.css"), false);
for (const specifier of [
  "fs",
  "node:fs",
  "npm:postgres@3.4.8",
  "jsr:@std/path",
  "https://esm.sh/x",
  "react-dom/client",
])
  assert.equal(forbidden("packages/contracts/src/domain.ts", specifier), true, specifier);
assert.equal(forbidden("packages/contracts/src/domain.test.ts", "node:test"), false);
assert.equal(forbidden("packages/contracts/src/domain.test.ts", "fs"), true);
assert.equal(forbidden("packages/contracts/src/domain.test.ts", "../../../apps/web/src/x"), true);
assert.equal(forbidden("packages/contracts/src/domain.ts", "zod"), false);
assert.deepEqual(
  imports(
    "fixture.ts",
    `
    import type { A } from "./A";
    export { B } from "./B";
    import C = require("./C");
    type D = import("./D").D;
    import("./E", { with: { type: "json" } });
    require("./F");
    // import("./comment")
    const text = 'import("./text")';
    other("./unrelated");
  `,
  ),
  ["./A", "./B", "./C", "./D", "./E", "./F"],
);
assert.deepEqual(imports("fixture.js", 'export * from "./A.js"; require(`./B.cjs`);'), [
  "./A.js",
  "./B.cjs",
]);
async function walk(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries
        .filter((e) => !["node_modules", "dist", ".temp"].includes(e.name))
        .map((e) =>
          e.isDirectory()
            ? walk(path.join(dir, e.name))
            : Promise.resolve([path.join(dir, e.name)]),
        ),
    );
    return nested.flat();
  } catch (error) {
    if ((error as { code: string }).code === "ENOENT") return [];
    throw error;
  }
}
const files = process.argv.includes("--fixtures-only")
  ? []
  : (await Promise.all(["apps/web", "packages/contracts", "supabase/functions"].map(walk)))
      .flat()
      .filter((f) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(f));
const violations: string[] = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const specifier of imports(file, source))
    if (forbidden(file, specifier)) violations.push(`${file}: forbidden import ${specifier}`);
}
if (violations.length) throw new Error(violations.join("\n"));
console.log(`Boundary fixtures and ${files.length} source files passed`);
