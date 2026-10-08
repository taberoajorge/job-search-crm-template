import { render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const realtime = vi.hoisted(() => ({
  filters: [] as { table: string; filter: string }[],
  handlers: [] as (() => void)[],
  status: undefined as ((status: string) => void) | undefined,
  removed: 0,
}));
vi.mock("@supabase/supabase-js", () => {
  const channel = {
    on: (_type: string, filter: { table: string; filter: string }, handler: () => void) => {
      realtime.filters.push(filter);
      realtime.handlers.push(handler);
      return channel;
    },
    subscribe: (callback: (status: string) => void) => {
      realtime.status = callback;
      return channel;
    },
  };
  return {
    createClient: () => ({
      rpc: vi.fn(),
      channel: () => channel,
      removeChannel: async () => {
        realtime.removed++;
      },
    }),
  };
});
const owner = "00000000-0000-4000-8000-000000000000";
const id = "22222222-2222-4222-8222-222222222222";
let api: typeof import("../src/shared/api/client");
let crm: typeof import("../src/shared/state/crm");
beforeAll(async () => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.resetModules();
  api = await import("../src/shared/api/client");
  crm = await import("../src/shared/state/crm");
});
afterAll(() => vi.unstubAllEnvs());

it("refetches owner records after realtime events and channel rejoins, then unsubscribes", async () => {
  let name = "Ana";
  const rpc = vi.spyOn(api, "operation").mockImplementation(
    async () =>
      ({
        items: [{ id, version: 1, user_id: owner, name }],
        has_more: false,
        next_cursor: null,
      }) as never,
  );
  function Names() {
    const contacts = crm.useRecords("contacts.search");
    return <p>{contacts.records.map((r) => String(r.name)).join(", ")}</p>;
  }
  const view = render(
    <crm.CrmProvider logout={async () => {}}>
      <Names />
    </crm.CrmProvider>,
  );
  await screen.findByText("Ana");
  expect(realtime.filters.map((f) => f.table)).toEqual(
    expect.arrayContaining(["jobs", "contacts", "outreach_events", "interviews"]),
  );
  expect(new Set(realtime.filters.map((f) => f.filter))).toEqual(new Set([`user_id=eq.${owner}`]));
  name = "Ana actualizada";
  realtime.handlers[1]!();
  await screen.findByText("Ana actualizada");
  realtime.status!("SUBSCRIBED");
  name = "Ana tras reconexión";
  realtime.status!("CHANNEL_ERROR");
  realtime.status!("SUBSCRIBED");
  await screen.findByText("Ana tras reconexión");
  expect(rpc.mock.calls.filter(([op]) => op === "contacts.search")).toHaveLength(3);
  view.unmount();
  await waitFor(() => expect(realtime.removed).toBe(1));
});
