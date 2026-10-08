import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { backupSchema, backupTables, parseOperation } from "./index.ts";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("backup coverage is versioned, owner-bound and cannot masquerade as a normalized import", () => {
  const backup = {
    format: "job-search-crm-backup",
    format_version: 1,
    schema_version: 1,
    exported_at: "2026-10-04T12:00:00Z",
    owner_id: owner,
    coverage: {
      included: ["jobs"],
      unavailable: ["automation_policies: not available"],
      excluded: ["Private CV bytes"],
      consistency: "paginated_non_atomic",
      restore_supported: false,
    },
    records: { jobs: [{ user_id: owner, title: "Synthetic job" }] },
  };
  assert.doesNotThrow(() => backupSchema.parse(backup));
  for (const patch of [
    { format_version: 2 },
    { coverage: { ...backup.coverage, included: ["jobs", "contacts"] } },
    { records: { jobs: [{ user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }] } },
    {
      records: { secret_tokens: [] },
      coverage: { ...backup.coverage, included: ["secret_tokens"] },
    },
  ])
    assert.throws(() => backupSchema.parse({ ...backup, ...patch }));
  assert.throws(() =>
    parseOperation("tasks.submit", {
      kind: "bulk_import",
      payload: backup,
      idempotency_key: owner,
    }),
  );
  assert.deepEqual(backupTables.notification_state.order, ["user_id"]);
  assert.equal(backupTables.automation_work.columns.includes("lease_token"), false);
});
test("backup families cover every owner-readable table granted in migrations", () => {
  const dir = new URL("../../../supabase/migrations/", import.meta.url);
  const granted = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql"))) {
    const sql = readFileSync(new URL(file, dir), "utf8");
    for (const [, table] of sql.matchAll(/grant select on public\.(\w+) to authenticated/g))
      granted.add(table!);
    for (const [, list, body] of sql.matchAll(/array\[([^\]]+)\]\s*loop([\s\S]*?)end loop/g))
      if (body!.includes("grant select on public.%I to authenticated"))
        for (const [, table] of list!.matchAll(/'(\w+)'/g)) granted.add(table!);
  }
  assert.ok(granted.has("automation_interview_intents") && granted.has("email_preferences"));
  for (const table of granted)
    assert.ok(Object.hasOwn(backupTables, table), `${table} not exported`);
});
