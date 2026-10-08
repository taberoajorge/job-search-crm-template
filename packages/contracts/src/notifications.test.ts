import { toolCatalog } from "./mcp/catalog.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseOperation,
  notificationSchemas,
  notificationLink,
  notificationOutputs,
  emailPreferences,
} from "./index.ts";
const id = "00000000-0000-4000-8000-000000000001";
test("notification tools enforce bounded owner intent and stable change targets", () => {
  assert.throws(() =>
    parseOperation("notifications.read", { id, read: true, idempotency_key: id }),
  );
  assert.throws(() =>
    parseOperation("notifications.configure", {
      expected_version: 1,
      idempotency_key: id,
      live_email: true,
      disclosure: "full-private",
    }),
  );
  assert.throws(() => parseOperation("notifications.list", { limit: 51 }));
  assert.throws(() =>
    parseOperation("notifications.get", { id, recipient: "other@example.invalid" }),
  );
  assert.equal(notificationSchemas["notifications.list"].parse({}).limit, 20);
  const target = new URL(notificationLink(id, id), "https://job.example.invalid");
  assert.equal(target.searchParams.get("section"), "changes");
  assert.equal(target.searchParams.get("notification"), id);
  assert.throws(() => notificationLink("not-a-uuid"));
  for (const name of ["notifications.list", "notifications.get", "notifications.preferences"])
    assert.equal(toolCatalog.find((t) => t.name === name)?.annotations.readOnlyHint, true);
  assert.equal(
    toolCatalog.find((t) => t.name === "notifications.read")?.annotations.readOnlyHint,
    false,
  );
  assert.throws(() =>
    notificationOutputs["notifications.list"].parse({
      items: [],
      has_more: false,
      next_cursor: null,
      cutoff: "2026-10-04T12:00:00Z",
      unread_count: 0,
    }),
  );
});
test("task email preferences share one read/write contract", () => {
  assert.equal(emailPreferences.input.safeParse({}).success, true);
  const write = { enabled: true, expected_version: 0, idempotency_key: id };
  assert.equal(emailPreferences.input.safeParse(write).success, true);
  assert.equal(emailPreferences.input.safeParse({ enabled: true }).success, false);
  assert.equal(emailPreferences.output.safeParse({ enabled: false, version: 0 }).success, true);
  const conflict = {
    error: {
      code: "CONFLICT",
      message: "Preference changed",
      retryable: false,
      current_version: 0,
    },
  };
  assert.equal(emailPreferences.output.safeParse(conflict).success, true);
});
