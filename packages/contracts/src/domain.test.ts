import { outputSchemas } from "./mcp/output.ts";
import { toolCatalog } from "./mcp/catalog.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOperation,
  automaticJobStage,
  requiresTransitionReason,
  JOB_STAGES,
  timeZone,
  operationSchemas,
  explanationSchema,
} from "./index.ts";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("strict domain boundaries preserve ownership and canonical states", () => {
  assert.throws(() => parseOperation("jobs.list", { stage: "interviewing" }));
  assert.throws(() =>
    parseOperation("jobs.upsert", {
      company_id: id,
      title: "Developer",
      idempotency_key: id,
      user_id: id,
    }),
  );
  assert.throws(() =>
    parseOperation("contacts.upsert", {
      company_id: id,
      name: "Test",
      idempotency_key: id,
      draft_note: "x".repeat(301),
    }),
  );
  assert.throws(() =>
    parseOperation("jobs.upsert", {
      company_id: id,
      title: "Developer",
      idempotency_key: id,
      posting_url: "javascript:alert(1)",
    }),
  );
  assert.throws(() =>
    parseOperation("jobs.upsert", { id, company_id: id, title: "Developer", idempotency_key: id }),
  );
  assert.throws(() =>
    parseOperation("outreach.draft", {
      body: "Hello",
      channel: "linkedin",
      kind: "message",
      idempotency_key: id,
    }),
  );
  assert.equal((parseOperation("jobs.list", {}) as { limit: number }).limit, 20);
  assert.equal(JOB_STAGES.length, 11);
  assert.equal(toolCatalog.length, 46);
});
test("contact activity cannot infer applications or reopen closed jobs", () => {
  assert.equal(automaticJobStage("radar", "replied"), "radar");
  assert.equal(automaticJobStage("applied", "replied"), "replied");
  assert.equal(automaticJobStage("offer", "replied"), "offer");
  assert.equal(automaticJobStage("archived", "replied"), "archived");
  assert.equal(requiresTransitionReason("interview", "review"), true);
  assert.equal(requiresTransitionReason("review", "applied"), false);
});

import { operationFixtures } from "./fixtures.ts";
test("cross-runtime wire fixtures validate", () => {
  for (const fixture of operationFixtures)
    assert.doesNotThrow(() => parseOperation(fixture.operation, fixture.input));
  assert.throws(() =>
    parseOperation("tasks.submit", {
      kind: "bulk_import",
      idempotency_key: id,
      payload: {
        import_namespace: "test",
        records: [
          { entity_type: "companies", legacy_id: "test", data: { id, name: "Test", user_id: id } },
        ],
      },
    }),
  );
});

test("MCP publishes an explicit documented catalog without company cascade mutations", () => {
  const names = new Set(toolCatalog.map((tool) => tool.name));
  for (const name of [
    "companies.merge",
    "companies.archive",
    "companies.preview_merge",
    "companies.preview_archive",
    "push.subscribe",
    "push.deactivate",
  ])
    assert.equal(names.has(name), false, `${name} must not be callable through MCP`);
  for (const name of [
    "jobs.list",
    "companies.list",
    "companies.health",
    "contacts.search",
    "tasks.get",
    "resumes.get_download",
  ])
    assert.equal(names.has(name), true, `${name} safe read remains available`);
  const finalize = toolCatalog.find((tool) => tool.name === "resumes.finalize")!;
  assert.ok(finalize);
  assert.equal(finalize.annotations.readOnlyHint, false);
  assert.equal(finalize.annotations.idempotentHint, true);
  assert.equal(finalize.annotations.destructiveHint, true);
  for (const tool of toolCatalog) {
    assert.ok(tool.description.length > 60 && tool.description !== tool.name);
    assert.equal(
      tool.description.startsWith(tool.annotations.readOnlyHint ? "Lectura:" : "Escritura:"),
      true,
    );
    assert.ok(tool.inputSchema && tool.outputSchema);
    if (!tool.annotations.readOnlyHint) assert.match(tool.description, /idempotency_key/);
  }
  assert.match(
    toolCatalog.find((tool) => tool.name === "outreach.mark_sent")!.description,
    /no envía mensajes/,
  );
  assert.match(
    toolCatalog.find((tool) => tool.name === "tasks.submit")!.description,
    /puede crear registros/,
  );
});
test("every output contract returns tool errors unchanged", () => {
  // The Edge returns parsed output, so no success branch may reshape or swallow an error.
  const failure = {
    error: { code: "FORBIDDEN", message: "Denied", field: "id", retryable: false },
  };
  for (const schema of Object.values(outputSchemas))
    assert.deepEqual(schema.parse(failure), failure);
  // A conflict before the first policy/pack exists reports version 0 and must stay a CONFLICT.
  const first = {
    error: { code: "CONFLICT", message: "Changed", retryable: false, current_version: 0 },
  };
  for (const name of ["automation.configure", "automation.pack.save"])
    assert.deepEqual(outputSchemas[name]!.parse(first), first, name);
});
test("time zones are canonical IANA names accepted by both Intl and SQL", () => {
  for (const zone of ["America/Lima", "America/Mexico_City", "UTC", "Etc/GMT+5"])
    assert.equal(timeZone.safeParse(zone).success, true, zone);
  for (const zone of ["america/lima", "+05:00", "posix/America/New_York", "Factory", "Mars/Base"])
    assert.equal(timeZone.safeParse(zone).success, false, zone);
});
test("jobs.upsert names the field the SQL rules would reject", () => {
  const issue = (input: object) =>
    operationSchemas["jobs.upsert"]
      .safeParse({ idempotency_key: id, ...input })
      .error?.issues[0]?.path.join(".");
  const create = { company_id: id, title: "Developer" };
  const edit = { id, expected_version: 1 };
  assert.equal(issue({ ...create, salary_min: 100 }), "currency");
  assert.equal(issue({ ...create, stage: "archived" }), "stage");
  assert.equal(issue({ ...create, stage: "applied" }), "applied_at");
  assert.equal(issue({ ...edit, applied_at: null }), "applied_at");
  const applied = { stage: "applied", applied_at: "2026-10-03T12:00:00Z" };
  assert.equal(issue({ ...create, ...applied, salary_min: 100, currency: "USD" }), undefined);
  assert.equal(issue({ ...edit, salary_min: 100 }), undefined); // the stored currency may apply
  assert.equal(issue({ ...edit, salary_min: 100, currency: null }), "currency");
  assert.equal(issue({ ...edit, salary_min: null, currency: null }), undefined);
});
test("effect hints follow one reviewed rule for open-world and append-only writes", () => {
  const names = (hint: "openWorldHint" | "destructiveHint", value: boolean) =>
    toolCatalog
      .filter((tool) => !tool.annotations.readOnlyHint && tool.annotations[hint] === value)
      .map((tool) => tool.name)
      .sort();
  assert.deepEqual(names("openWorldHint", true), [
    "automation.commit",
    "automation.trigger",
    "notifications.configure",
    "tasks.submit",
  ]);
  assert.deepEqual(names("destructiveHint", false), [
    "automation.company-guide.save",
    "automation.pack.save",
    "automation.reserve",
    "outreach.draft",
    "verifications.record",
  ]);
  for (const tool of toolCatalog.filter((tool) => tool.annotations.readOnlyHint))
    assert.equal(tool.annotations.openWorldHint, false, tool.name);
});
test("automation inputs mirror the SQL dispatcher rules", () => {
  const ok = (
    operation: "automation.trigger" | "automation.checkpoint" | "automation.heartbeat",
    input: object,
  ) => operationSchemas[operation].safeParse({ idempotency_key: id, ...input }).success;
  assert.equal(ok("automation.trigger", { scope: "classification" }), false);
  assert.equal(ok("automation.trigger", { scope: "classification", on_demand: true }), true);
  assert.equal(ok("automation.trigger", { scope: "all", on_demand: true }), false);
  assert.equal(ok("automation.trigger", { on_demand: true }), false);
  assert.equal(
    ok("automation.trigger", { scope: "existing", on_demand: true, retry_failed: true }),
    true,
  );
  const lease = { work_id: id, lease_token: id, expected_version: 1, checkpoint: {}, error: null };
  assert.equal(ok("automation.checkpoint", { ...lease, state: "queued", children: [] }), false);
  const child = { id, kind: "classify", job_id: null, checkpoint: {} };
  assert.equal(
    ok("automation.checkpoint", { ...lease, state: "waiting", children: [child] }),
    false,
  );
  assert.equal(ok("automation.checkpoint", { ...lease, state: "waiting", children: [] }), true);
  const beat = { executor_id: id, status: "online", work_id: id };
  assert.equal(ok("automation.heartbeat", beat), false);
  assert.equal(ok("automation.heartbeat", { ...beat, lease_token: id }), true);
  assert.throws(
    () =>
      parseOperation("automation.commit", {
        idempotency_key: id,
        work_id: id,
        lease_token: id,
        expected_version: 1,
        operation: "contacts.upsert",
        input: { idempotency_key: id, company_id: id, name: "Persona", status: "replied" },
      }),
    /contact events/,
  );
});
test("company explanations use the SQL trimmed bounds", () => {
  const explanation = (text: string) =>
    explanationSchema.safeParse({
      explanation_es: text,
      explanation_en: "Texto",
      coverage: "unknown",
      evidence: [],
    }).success;
  assert.equal(explanation("   "), false);
  assert.equal(explanation(` ${"a".repeat(8000)} `), true);
});
test("search.semantic publishes no filter the SQL ignores", () => {
  // The SQL semantic branch never reads a text query, so the contract must not offer one.
  const input = { entity_type: "jobs", embedding: [1], model: "synthetic" };
  assert.doesNotThrow(() => parseOperation("search.semantic", input));
  assert.throws(() => parseOperation("search.semantic", { ...input, query: "react" }));
});
test("summary ranges and resume filters are bounded before the call", () => {
  const from = "2026-10-05T00:00:00Z";
  const to = "2026-10-04T00:00:00Z";
  assert.throws(() => parseOperation("dashboard.summary", { from, to }));
  assert.doesNotThrow(() => parseOperation("dashboard.summary", { from: to, to: from }));
  assert.throws(() => parseOperation("resumes.list", { country: "x".repeat(501) }));
});
test("push.deactivate targets exactly one device", () => {
  assert.throws(() => parseOperation("push.deactivate", { idempotency_key: id }));
  assert.throws(() =>
    parseOperation("push.deactivate", {
      idempotency_key: id,
      id,
      endpoint: "https://push.example/a",
    }),
  );
  assert.doesNotThrow(() =>
    parseOperation("push.deactivate", { idempotency_key: id, endpoint: "https://push.example/a" }),
  );
});
test("every operation has an output contract", () => {
  for (const name of Object.keys(operationSchemas))
    assert.ok(outputSchemas[name], `${name} has no output schema`);
  const preview = { source_version: 2, target_version: 3, jobs: 1, contacts: 0 };
  assert.deepEqual(outputSchemas["companies.preview_merge"]!.parse(preview), preview);
  assert.deepEqual(outputSchemas["push.deactivate"]!.parse({ active: false }), { active: false });
});
test("drafts and automation commits keep human-owned contact facts", () => {
  const draft = { idempotency_key: id, channel: "linkedin", kind: "invitation", contact_id: id };
  assert.throws(() => parseOperation("outreach.draft", { ...draft, body: "x".repeat(301) }));
  assert.doesNotThrow(() => parseOperation("outreach.draft", { ...draft, body: "x".repeat(300) }));
  assert.doesNotThrow(() =>
    parseOperation("outreach.draft", { ...draft, kind: "message", body: "x".repeat(301) }),
  );
  const lease = { idempotency_key: id, work_id: id, lease_token: id, expected_version: 1 };
  const link = { idempotency_key: id, id, expected_version: 2, job_id: id };
  assert.doesNotThrow(() =>
    parseOperation("automation.commit", { ...lease, operation: "contacts.upsert", input: link }),
  );
  assert.throws(
    () =>
      parseOperation("automation.commit", {
        ...lease,
        operation: "contacts.upsert",
        input: { ...link, notes: "Fuente: https://example.com" },
      }),
    /only link an existing contact/,
  );
});
test("outreach.cancel withdraws a queued reminder with a reason and keeps history", () => {
  const input = { idempotency_key: id, id, expected_version: 3, reason: "Recordatorio duplicado" };
  assert.doesNotThrow(() => parseOperation("outreach.cancel", input));
  assert.throws(() => parseOperation("outreach.cancel", { ...input, reason: " " }));
  assert.throws(() => parseOperation("outreach.cancel", { ...input, state: "cancelled" }));
  const tool = toolCatalog.find((t) => t.name === "outreach.cancel")!;
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: true,
    openWorldHint: false,
  });
});
