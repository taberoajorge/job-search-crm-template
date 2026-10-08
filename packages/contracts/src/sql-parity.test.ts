import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { entityFields, jobStage, contactStatus } from "./domain.ts";
import { workKind, workState } from "./automation/index.ts";
import { notificationEventSchema, notificationStateSchema } from "./notifications.ts";
import { recordSchemas } from "./mcp/output.ts";
import { toolCatalog } from "./mcp/catalog.ts";
import { operationSchemas } from "./mcp/index.ts";

// packages/AGENTS.md: literal catalogs are canonical and must match SQL CHECKs.
const dir = new URL("../../../supabase/migrations/", import.meta.url);
const literals = (raw: string) => [...raw.matchAll(/'([^']*)'/g)].map((m) => m[1]!).sort();
function sqlChecks() {
  const checks = new Map<string, string[]>(); // table.column -> final IN list
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(new URL(file, dir), "utf8");
    for (const [statement, table] of sql.matchAll(
      /(?:create|alter) table (?:if not exists )?public\.(\w+)[^;]*;/g,
    )) {
      for (const [, column, list] of statement.matchAll(
        /(\w+) text[^,]*?check\s*\(\s*\1 in \(([^)]*)\)\)/g,
      ))
        checks.set(`${table}.${column}`, literals(list!));
      for (const [, column, list] of statement.matchAll(
        /add constraint \w+ check\s*\(\s*(\w+) in \(([^)]*)\)\)/g,
      ))
        checks.set(`${table}.${column}`, literals(list!));
    }
  }
  return checks;
}
const values = (schema: unknown): string[] => {
  const s = schema as { options?: string[]; unwrap?: () => unknown };
  return s.options ? [...s.options].sort() : values(s.unwrap!());
};

test("zod literal catalogs equal the final SQL CHECK lists", () => {
  const expected = {
    "jobs.stage": jobStage,
    "jobs.applied_date_precision": entityFields.jobs.applied_date_precision,
    "contacts.status": contactStatus,
    "sources.kind": entityFields.sources.kind,
    "resumes.media_type": entityFields.resumes.media_type,
    "outreach_events.channel": entityFields.outreach_events.channel,
    "outreach_events.kind": entityFields.outreach_events.kind,
    "outreach_events.state": entityFields.outreach_events.state,
    "interviews.state": entityFields.interviews.state,
    "interviews.language": entityFields.interviews.language,
    "interviews.format": entityFields.interviews.format,
    "verifications.status": entityFields.verifications.status,
    "automation_work.kind": workKind,
    "automation_work.state": workState,
    "automation_events.kind": notificationEventSchema.shape.kind,
    "notification_state.disclosure": notificationStateSchema.shape.disclosure,
  };
  const checks = sqlChecks();
  for (const [column, schema] of Object.entries(expected)) {
    assert.ok(checks.has(column), `${column} CHECK not found in migrations`);
    assert.deepEqual(values(schema), checks.get(column), column);
  }
});

test("record output schemas declare exactly the generated database.ts row columns", () => {
  // database.ts is regenerated with each migration (CI diff gate), so a new column must reach contracts.
  const types = readFileSync(new URL("./database.ts", import.meta.url), "utf8");
  for (const [table, schema] of Object.entries(recordSchemas)) {
    const row = types.match(
      new RegExp(`\\n {6}${table}: \\{\\n {8}Row: \\{([\\s\\S]*?)\\n {8}\\}`),
    );
    assert.ok(row, `${table} Row not found`);
    const columns = [...row[1]!.matchAll(/\n {10}(\w+)\??:/g)].map((m) => m[1]!).sort();
    assert.deepEqual(Object.keys(schema.shape).sort(), columns, table);
  }
});

test("SQL lets MCP OAuth grants reach exactly the published catalog", () => {
  // contracts-001: crm_operation refuses client_id tokens outside this list; the latest definition wins.
  const allow = /client_id' is not null and coalesce\(p_operation,''\)<>all\(array\[([^\]]+)\]/;
  let list: string[] | undefined;
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const match = readFileSync(new URL(file, dir), "utf8").match(allow);
    if (match) list = literals(match[1]!);
  }
  assert.ok(list, "MCP operation allowlist not found in migrations");
  assert.deepEqual(list, toolCatalog.map((tool) => tool.name).sort());
});

test("the SQL hardening fixture probes exactly the keys each operation publishes", () => {
  // supabase/tests/hardening.fixture (e2e-tests-038) feeds every published key to the SQL validator.
  // automation.* and notifications.* run through their own SQL validators and are probed elsewhere.
  const fixture = readFileSync(
    new URL("../../../supabase/tests/hardening.fixture", import.meta.url),
    "utf8",
  );
  const literal = fixture.match(
    /jsonb_each\('(\{"contacts\.preview_erasure".*?\})'(?:::jsonb)?\)/s,
  );
  assert.ok(literal, "operation key map not found in hardening.fixture");
  const map = JSON.parse(literal[1]!) as Record<string, string[]>;
  const keys = (schema: unknown): string[] => {
    const s = schema as { shape?: object; options?: unknown[] };
    return s.shape ? Object.keys(s.shape) : [...new Set((s.options ?? []).flatMap(keys))];
  };
  const probed = Object.keys(operationSchemas).filter(
    (op) => !op.startsWith("automation.") && !op.startsWith("notifications."),
  );
  assert.deepEqual(Object.keys(map).sort(), probed.sort());
  for (const op of probed)
    assert.deepEqual(
      [...map[op]!].sort(),
      keys(operationSchemas[op as keyof typeof operationSchemas]).sort(),
      op,
    );
});
