import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { it, expect, vi } from "vitest";
import { Notifications, NotificationPreferences } from "../src/screens/Notifications";
import * as api from "../src/shared/api/client";
const id = "00000000-0000-4000-8000-000000000001";
it("keeps generic defaults and the explicit preference draft after a failed save", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mock = vi.spyOn(api, "operation").mockImplementation(async (name) => {
    if (name === "notifications.preferences")
      return { user_id: id, version: 1, live_email: false, disclosure: "generic" } as never;
    if (name === "notifications.configure") throw new Error("Respuesta perdida");
    throw new Error(name);
  });
  const app = render(
    <QueryClientProvider client={client}>
      <NotificationPreferences />
    </QueryClientProvider>,
  );
  const select = await screen.findByLabelText("Contenido del correo");
  const live = screen.getByLabelText(
    "Enviar cambios agrupados cada 15 minutos",
  ) as HTMLInputElement;
  expect((select as HTMLSelectElement).value).toBe("generic");
  expect(live.checked).toBe(false);
  fireEvent.change(select, { target: { value: "vacancy_summary" } });
  fireEvent.click(live);
  fireEvent.click(screen.getByRole("button", { name: "Guardar preferencias de avisos" }));
  await screen.findByText(/Respuesta perdida/);
  expect((select as HTMLSelectElement).value).toBe("vacancy_summary");
  expect(live.checked).toBe(true);
  expect(mock.mock.calls.find(([name]) => name === "notifications.configure")?.[1]).toMatchObject({
    live_email: true,
    disclosure: "vacancy_summary",
    expected_version: 1,
  });
  app.unmount();
  mock.mockRestore();
  client.clear();
});
it("loads details on expansion only and preserves an ambiguous read intent", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const writes: Record<string, unknown>[] = [];
  const mock = vi.spyOn(api, "operation").mockImplementation(async (name, input) => {
    if (name === "notifications.list")
      return {
        items: [
          {
            id,
            user_id: id,
            version: 1,
            created_at: "2026-10-04T12:00:00Z",
            updated_at: "2026-10-04T12:00:00Z",
            window_start: "2026-10-04T12:00:00Z",
            window_end: "2026-10-04T12:15:00Z",
            read_at: null,
            vacancies: 1,
            open: false,
            delivery: "accepted",
            delivery_verified: false,
          },
        ],
        has_more: false,
        next_cursor: null,
        state_version: 1,
        cutoff: "2026-10-04T12:00:00Z",
        unread_count: 1,
      } as never;
    if (name === "notifications.preferences")
      return { user_id: id, version: 1, live_email: false, disclosure: "generic" } as never;
    if (name === "notifications.read") {
      writes.push(input!);
      if (writes.length === 1) throw new Error("Respuesta perdida");
      return { id, version: 2 } as never;
    }
    if (name === "notifications.get")
      return {
        batch: {
          id,
          user_id: id,
          version: 1,
          created_at: "2026-10-04T12:00:00Z",
          updated_at: "2026-10-04T12:00:00Z",
          window_start: "2026-10-04T12:00:00Z",
          window_end: "2026-10-04T12:15:00Z",
          read_at: null,
          vacancies: 1,
          open: false,
          delivery: "accepted",
          delivery_verified: false,
        },
        items: [],
        has_more: false,
        next_cursor: null,
      } as never;
    throw new Error(name);
  });
  const app = render(
    <QueryClientProvider client={client}>
      <Notifications />
    </QueryClientProvider>,
  );
  await screen.findByText("Una vacante actualizada");
  expect(screen.queryByLabelText("Contenido del correo")).toBeNull();
  expect(screen.getByRole("link", { name: "Ajustar avisos" }).getAttribute("href")).toBe(
    "/?screen=settings&section=notifications",
  );
  expect(mock.mock.calls.some(([name]) => name === "notifications.preferences")).toBe(false);
  expect(mock.mock.calls.filter(([name]) => name === "notifications.get")).toHaveLength(0);
  expect(writes).toHaveLength(0);
  const details = screen.getByText("Ver cambios del lote").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await waitFor(() =>
    expect(mock.mock.calls.some(([name]) => name === "notifications.get")).toBe(true),
  );
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: /^Marcar leída$/ }));
  await screen.findByText(/Respuesta perdida/);
  app.unmount();
  const reopened = render(
    <QueryClientProvider client={client}>
      <Notifications />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Reintentar el mismo cambio" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual(writes[0]);
  reopened.unmount();
  mock.mockRestore();
  client.clear();
});
