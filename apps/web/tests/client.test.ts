import { afterAll, beforeAll, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc }) }));
const owner = "00000000-0000-4000-8000-000000000000";
const id = "22222222-2222-4222-8222-222222222222";
let api: typeof import("../src/shared/api/client");
beforeAll(async () => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.resetModules();
  api = await import("../src/shared/api/client");
});
afterAll(() => vi.unstubAllEnvs());

const call = (data: unknown, error: unknown = null) => {
  rpc.mockResolvedValueOnce({ data, error });
  return api.operation("jobs.get", { id });
};

it("maps the real RPC transport, its error shapes and response checks", async () => {
  expect(api.configured).toBe(true);
  api.setAuthorized(false);
  await expect(api.operation("jobs.get", { id })).rejects.toMatchObject({
    code: "UNAUTHENTICATED",
  });
  expect(rpc).not.toHaveBeenCalled();
  api.setAuthorized(true);

  await expect(call({ id, version: 2, user_id: owner })).resolves.toEqual({
    id,
    version: 2,
    user_id: owner,
  });
  expect(rpc).toHaveBeenLastCalledWith("crm_operation", {
    p_operation: "jobs.get",
    p_input: { id },
  });
  await expect(
    call(null, {
      message: "conflict",
      details: JSON.stringify({ code: "CONFLICT", message: "stale", current_version: 3 }),
    }),
  ).rejects.toMatchObject({ code: "CONFLICT", current_version: 3 });
  await expect(call(null, { message: "upstream timeout" })).rejects.toMatchObject({
    code: "TEMPORARY_FAILURE",
    message: "No se pudo confirmar el resultado. Reintenta la solicitud original con conexión.",
  });
  await expect(
    call({ error: { code: "VALIDATION_ERROR", message: "bad", field: "title" } }),
  ).rejects.toMatchObject({ code: "VALIDATION_ERROR", field: "title" });
  await expect(call({ id, version: 2, user_id: id })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(call({ id: "not-a-uuid", version: 2 })).rejects.toMatchObject({
    code: "TEMPORARY_FAILURE",
  });
  await expect(call({ id, version: 0 })).rejects.toMatchObject({ code: "TEMPORARY_FAILURE" });
  await expect(
    call({ items: [{ id, version: 1, user_id: id }], has_more: false, next_cursor: null }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  api.setAuthorized(false);
});
