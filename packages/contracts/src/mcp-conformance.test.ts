import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { toolCatalog } from "./mcp/catalog.ts";
import { outputSchemas } from "./mcp/output.ts";
import { operationSchemas, type Operation } from "./mcp/index.ts";
import { operationFixtures, fixtureIds as ids } from "./fixtures.ts";
import { email, safeUrl, timestamp } from "./domain.ts";

// Same settings as the MCP SDK client validator (@modelcontextprotocol/sdk validation/ajv-provider).
const ajv = new Ajv({
  strict: false,
  validateFormats: true,
  validateSchema: false,
  allErrors: true,
});
addFormats(ajv);
const tools = new Map(toolCatalog.map((tool) => [tool.name, tool]));
const check = (schema: object, value: unknown) => {
  const validate = ajv.compile(schema);
  return validate(value) ? "" : ajv.errorsText(validate.errors);
};

// SQL-shaped values: Postgres to_jsonb renders +00:00 offsets with microseconds.
const at = "2026-10-07T00:37:00.123456+00:00";
const iri = "https://social.example.invalid/person";
const row = (id: string) => ({
  id,
  user_id: ids.owner,
  created_at: at,
  updated_at: at,
  version: 1,
});
const company = {
  ...row(ids.company),
  name: "Ejemplo",
  domain: null,
  website_url: "https://example.com/a|b",
  linkedin_url: iri,
  type: null,
  product: null,
  archived_at: null,
};
const contact = {
  ...row(ids.contact),
  company_id: ids.company,
  job_id: null,
  name: "Persona",
  role: null,
  email: "person@example.invalid",
  linkedin_url: iri,
  status: "uncontacted",
  priority: null,
  invite_at: at,
  last_interacted_at: null,
  draft_note: "",
  draft_message: "",
  queued_at: null,
  resume_id: null,
  notes: "",
  archived_at: null,
};
const job = {
  ...row(ids.job),
  company_id: ids.company,
  title: "Ingeniería",
  stage: "applied",
  source_id: null,
  source_posting_id: null,
  posting_url: "https://jobs.example.invalid/vacante/ejemplo",
  description_summary: null,
  salary_text: null,
  salary_min: 5000,
  salary_max: null,
  currency: "USD",
  location: null,
  fit_score: null,
  fit_raw: null,
  posted_on: "2026-10-01",
  applied_at: at,
  applied_date_precision: "instant",
  notes: "",
  viewed: false,
  viewed_at: null,
  resume_id: null,
};
const interview = {
  ...row(ids.key),
  job_id: ids.job,
  scheduled_at: "2026-10-08T15:30:00+00:00",
  timezone: "America/Lima",
  state: "planned",
  language: "es",
  format: "technical",
  interviewer_ids: [],
  interviewer_notes: "",
  meeting_url: "https://meet.example.invalid/sala",
  notes: "",
  next_step: null,
};
const verification = {
  ...row(ids.key),
  job_id: ids.job,
  company_id: null,
  status: "confirmed",
  checked_at: at,
  evidence_url: iri,
  source_id: null,
  notes: "",
};
const page = (items: unknown[]) => ({ items, has_more: true, next_cursor: "opaque" });
const outputs: [Operation, unknown][] = [
  ["companies.list", page([{ ...company, verification }])],
  ["companies.upsert", company],
  ["contacts.search", page([{ ...contact, verification: null }])],
  ["contacts.upsert", { contact, changed_jobs: [] }],
  ["jobs.list", page([{ ...job, verification, triage: null }])],
  ["jobs.get", { ...job, contacts: [contact], interviews: [interview], verification: null }],
  ["jobs.transition", { job, audit_event_id: ids.key }],
  ["interviews.list", page([interview])],
  ["verifications.record", verification],
];

test("every published schema compiles with the MCP client validator", () => {
  // Budget for clients that load tools/list eagerly (was ~399 KB with inline uuid/date-time regexes).
  assert.ok(JSON.stringify(toolCatalog).length < 260_000);
  for (const tool of toolCatalog) {
    assert.doesNotThrow(() => ajv.compile(tool.inputSchema), `${tool.name} input`);
    assert.doesNotThrow(() => ajv.compile(tool.outputSchema), `${tool.name} output`);
  }
});

test("Edge output for SQL-shaped rows validates against the published outputSchema", () => {
  for (const [operation, payload] of outputs) {
    // The Edge returns parsed.data, so that is what clients validate.
    const parsed = outputSchemas[operation]!.safeParse(payload);
    assert.ok(parsed.success, `${operation} runtime: ${parsed.error?.message}`);
    assert.equal(check(tools.get(operation)!.outputSchema, parsed.data), "", operation);
  }
  const failure = {
    error: { code: "CONFLICT", message: "Stale", retryable: false, current_version: 2 },
  };
  for (const tool of toolCatalog) assert.equal(check(tool.outputSchema, failure), "", tool.name);
});

test("inputs accepted at runtime are accepted by the published inputSchema", () => {
  const inputs: [Operation, unknown][] = [
    ...operationFixtures.map(({ operation, input }) => [operation, input] as [Operation, unknown]),
    [
      "tasks.submit",
      {
        kind: "embed_records",
        idempotency_key: ids.key,
        payload: { records: [{ entity_type: "jobs", id: ids.job }] },
      },
    ],
  ];
  // Every tool whose runtime schema accepts {} (defaults fill limit etc.) must publish that too.
  for (const tool of toolCatalog)
    if (operationSchemas[tool.name as Operation].safeParse({}).success)
      inputs.push([tool.name as Operation, {}]);
  assert.ok(inputs.some(([name]) => name === "jobs.list"));
  for (const [operation, input] of inputs) {
    assert.doesNotThrow(() => operationSchemas[operation].parse(input), operation);
    assert.equal(check(tools.get(operation)!.inputSchema, input), "", operation);
  }
  for (const tool of toolCatalog)
    for (const key of ["oneOf", "anyOf", "allOf"])
      assert.equal(key in tool.inputSchema, false, `${tool.name} root ${key}`);
});

test("runtime rejects values the published formats reject, and accepts stored SQL values", () => {
  assert.equal(timestamp.safeParse("2026-10-03T10:00Z").success, false);
  assert.equal(timestamp.safeParse("2026-10-03T10:00:00+00:00").success, true);
  assert.equal(safeUrl.safeParse("https://example.com/a b").success, false);
  assert.equal(safeUrl.safeParse("javascript:alert(1)").success, false);
  assert.equal(safeUrl.safeParse(iri).success, true);
  // SQL compares the scheme case-insensitively (!~*), so runtime and the published pattern do too.
  const urlSchema = tools.get("companies.upsert")!.inputSchema.properties as Record<string, object>;
  for (const url of ["HTTPS://EXAMPLE.invalid/Posting?id=1", "Http://example.com/x"]) {
    assert.equal(safeUrl.safeParse(url).success, true, url);
    assert.equal(check(urlSchema.website_url!, url), "", url);
  }
  assert.notEqual(check(urlSchema.website_url!, "ftp://example.com"), "");
  assert.equal(email.safeParse("user@x.c").success, true);
  assert.equal(email.safeParse("a b@x.co").success, false);
});

test("a column added by a migration is stripped, not rejected, before clients see it", () => {
  for (const [operation, payload] of [
    ["contacts.search", page([{ ...contact, verification: null, added_later: 1 }])],
    [
      "notifications.preferences",
      { user_id: ids.owner, version: 1, live_email: false, disclosure: "generic", added_later: 1 },
    ],
  ] as const) {
    const parsed = outputSchemas[operation]!.safeParse(payload);
    assert.ok(parsed.success, operation);
    assert.equal(check(tools.get(operation)!.outputSchema, parsed.data), "", operation);
  }
});

test("published outputs tolerate keys added after a client cached tools/list", () => {
  for (const tool of toolCatalog)
    assert.equal(
      JSON.stringify(tool.outputSchema).includes('"additionalProperties":false'),
      false,
      tool.name,
    );
  // An older client keeps this schema while a newer server sends an extra work column.
  const status = tools.get("automation.status")!.outputSchema;
  const payload = {
    policy: null,
    policy_version: 0,
    server_time: at,
    heartbeat_at: null,
    executor_status: null,
    executor_stale: true,
    profiles: [],
    work: [],
    spend: { daily: 0, monthly: 0 },
    added_later: true,
  };
  assert.equal(check(status, payload), "");
});
