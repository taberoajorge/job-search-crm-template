import test from "node:test";
import assert from "node:assert/strict";
import { parseOperation, outputSchemas, erasureInventory, erasedReplay } from "./index.ts";
import { toolCatalog } from "./mcp/catalog.ts";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("old receipts acknowledge erased identities without restoring private bodies", () => {
  const tombstone = { id, version: 1, erased: true };
  for (const operation of [
    "outreach.draft",
    "outreach.queue",
    "outreach.mark_sent",
    "interviews.upsert",
  ]) {
    assert.doesNotThrow(() => outputSchemas[operation]!.parse(tombstone));
    assert.throws(() => outputSchemas[operation]!.parse({ ...tombstone, body: "erased draft" }));
  }
  assert.doesNotThrow(() =>
    outputSchemas["contacts.upsert"]!.parse({ contact: tombstone, changed_jobs: [] }),
  );
  assert.doesNotThrow(() =>
    outputSchemas["outreach.record_response"]!.parse({
      event: tombstone,
      contact: tombstone,
      changed_jobs: [],
    }),
  );
  assert.throws(() =>
    outputSchemas["contacts.upsert"]!.parse({
      contact: { ...tombstone, email: "private@example.invalid" },
      changed_jobs: [],
    }),
  );
});
test("erasure requires exact version-bound owner review and is absent from agent tools", () => {
  const input = {
    id,
    expected_version: 1,
    inventory_hash: "a".repeat(64),
    owner_reviewed: true,
    idempotency_key: id,
  };
  assert.deepEqual(parseOperation("contacts.erase", input), input);
  for (const patch of [
    { owner_reviewed: false },
    { inventory_hash: "invalid" },
    { expected_version: 0 },
    { confirmation: true },
    { user_id: id },
  ])
    assert.throws(() => parseOperation("contacts.erase", { ...input, ...patch }));
  assert.throws(() =>
    parseOperation("contacts.erase", { id, confirmation: true, idempotency_key: id }),
  );
  assert.equal(
    toolCatalog.some(
      ({ name }) => name === "contacts.erase" || name === "contacts.preview_erasure",
    ),
    false,
  );
  assert.throws(() =>
    outputSchemas["contacts.erase"]!.parse({ contact_id: id, erased: true, version: 1 }),
  );
});

test("recent history remains bounded and rejects private bodies and fabricated metadata", () => {
  const summary = {
    counts_by_stage: {},
    unknown_application_dates: 0,
    dated_applications: 0,
    funnel: {},
  };
  assert.doesNotThrow(() => outputSchemas["dashboard.summary"]!.parse(summary));
  const event = {
    event_id: id,
    entity_type: "jobs",
    entity_id: id,
    action: "upsert",
    occurred_at: "2026-10-04T12:00:00Z",
    changed_fields: ["stage"],
    history: "recorded",
  };
  const recent_updates = { items: [event], limit: 12, history_scope: "canonical_audit" };
  assert.doesNotThrow(() =>
    outputSchemas["dashboard.summary"]!.parse({ ...summary, recent_updates }),
  );
  assert.throws(() =>
    outputSchemas["dashboard.summary"]!.parse({
      ...summary,
      recent_updates: { ...recent_updates, items: Array(13).fill(event) },
    }),
  );
  assert.throws(() =>
    outputSchemas["dashboard.summary"]!.parse({
      ...summary,
      recent_updates: { ...recent_updates, items: [{ ...event, body: "private contact draft" }] },
    }),
  );
});
test("erasure inventory reads previews from before and after the automation_work count", () => {
  const before = {
    contact: 1,
    outreach: 2,
    interviews: 0,
    audits: 3,
    receipts: 1,
    import_tasks: 0,
    legacy_links: 0,
    embeddings: 1,
  };
  assert.deepEqual(erasureInventory.parse(before), before);
  assert.deepEqual(erasureInventory.parse({ ...before, automation_work: 4 }), {
    ...before,
    automation_work: 4,
  });
  assert.throws(() => erasureInventory.parse({ ...before, automation_work: -1 }));
});
test("minimized erased copies keep their timestamps", () => {
  const at = "2026-10-07T00:37:00.123456+00:00";
  const copy = { id, erased: true, version: 2, created_at: at, updated_at: at, occurred_at: at };
  assert.deepEqual(erasedReplay.parse(copy), copy);
  assert.deepEqual(outputSchemas["outreach.draft"]!.parse(copy), copy);
  assert.throws(() => erasedReplay.parse({ ...copy, notes: "private" }));
});
