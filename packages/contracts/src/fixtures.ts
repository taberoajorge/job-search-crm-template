export const fixtureIds = {
  owner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  company: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  job: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  contact: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  key: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
} as const;
export const operationFixtures = [
  {
    operation: "jobs.upsert",
    input: {
      company_id: fixtureIds.company,
      title: "Ingeniero frontend",
      idempotency_key: fixtureIds.key,
    },
  },
  {
    operation: "jobs.transition",
    input: {
      id: fixtureIds.job,
      expected_version: 1,
      stage: "applied",
      applied_at: "2026-10-03T12:00:00Z",
      idempotency_key: fixtureIds.key,
    },
  },
  {
    operation: "contacts.upsert",
    input: {
      id: fixtureIds.contact,
      expected_version: 2,
      draft_note: "Hola, me interesa conocer esta vacante.",
      idempotency_key: fixtureIds.key,
    },
  },
  {
    operation: "tasks.submit",
    input: {
      kind: "bulk_import",
      idempotency_key: fixtureIds.key,
      payload: {
        import_namespace: "legacy-test",
        records: [
          {
            entity_type: "companies",
            legacy_id: "company-1",
            data: { id: fixtureIds.company, name: "Example" },
          },
        ],
      },
    },
  },
] as const;
