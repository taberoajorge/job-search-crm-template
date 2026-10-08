import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOperation, operationSchemas } from "./mcp/index.ts";

test("job filters accept literal locations and explicit same-currency salary ranges", () => {
  const input = {
    location_query: "MX_%\\literal",
    salary_min: 0,
    salary_max: 200,
    currency: "USD",
    salary_known: true,
    stage: "review",
  };
  assert.deepEqual(parseOperation("jobs.list", input), { ...input, limit: 20 });
  assert.doesNotThrow(() => parseOperation("jobs.list", { salary_known: false }));
  assert.doesNotThrow(() => parseOperation("jobs.list", { currency: "EUR" }));
  assert.doesNotThrow(() => parseOperation("jobs.list", { salary_max: 0, currency: "USD" }));
});

test("job filters reject inferred or contradictory salary and invalid strict inputs", () => {
  for (const input of [
    { salary_min: 1 },
    { salary_max: 1 },
    { salary_min: -1, currency: "USD" },
    { salary_min: Infinity, currency: "USD" },
    { salary_min: NaN, currency: "USD" },
    { salary_min: "100", currency: "USD" },
    { salary_min: 20, salary_max: 10, currency: "USD" },
    { salary_known: false, salary_min: 0, currency: "USD" },
    { salary_known: false, salary_max: 0, currency: "USD" },
    { salary_known: "false" },
    { salary_known: null },
    { currency: "usd" },
    { currency: "US" },
    { location_query: "x".repeat(501) },
    { location_query: null },
    { country: "MX" },
    { salary_text: "$100k" },
  ])
    assert.throws(() => parseOperation("jobs.list", input));
});

test("job recency preserves omitted-order compatibility and validates actual date boundaries", () => {
  assert.deepEqual(parseOperation("jobs.list", {}), { limit: 20 });
  for (const sort of ["created_desc", "posted_desc"])
    assert.doesNotThrow(() => parseOperation("jobs.list", { sort }));
  assert.doesNotThrow(() =>
    parseOperation("jobs.list", {
      added_from: "2026-10-03T00:00:00-06:00",
      added_before: "2026-10-04T00:00:00-06:00",
      posted_from: "2026-10-03",
      posted_to: "2026-10-03",
    }),
  );
  for (const input of [
    { sort: "updated_desc" },
    { sort: null },
    { added_from: "infinity" },
    { added_before: "2026-02-30T00:00:00Z" },
    { posted_from: "2026-02-30" },
    { posted_to: null },
    { posted_from: "2026-10-04", posted_to: "2026-10-03" },
    { added_from: "2026-10-03T10:00:00Z", added_before: "2026-10-03T10:00:00Z" },
  ])
    assert.throws(() => parseOperation("jobs.list", input));
});
test("job filters normalize ids and reject empty location text", () => {
  const upper = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
  assert.equal(
    operationSchemas["jobs.list"].parse({ company_id: upper }).company_id,
    upper.toLowerCase(),
  );
  assert.throws(() => parseOperation("jobs.list", { location_query: "  " }));
  assert.throws(() => parseOperation("jobs.list", { added_from: "2026-10-03T10:00Z" }));
});
