import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { FilterDialog } from "../src/shared/ui/collections";
import { addedDayBoundary } from "../src/screens/Pipeline";
import { ResumeFile } from "../src/screens/Resumes";
import * as files from "../src/shared/api/files";
import * as api from "../src/shared/api/client";
import { publicPushKey, subscribePush } from "../src/shared/api/push";
import { stored } from "../src/shared/state/storage";
import { ConnectionStatus, dismissDialogs, SyncStatus } from "../src/app/App";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

const pdfjs = vi.hoisted(() => ({ getDocument: vi.fn(), destroy: vi.fn() }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: (options: unknown) => {
    pdfjs.getDocument(options);
    return {
      promise: Promise.resolve({ numPages: 1, getPage: () => new Promise(() => {}) }),
      destroy: pdfjs.destroy,
    };
  },
}));
afterEach(() => vi.unstubAllGlobals());
it("keeps tentative filters out of applied state and restores values after cancel, apply and clear", async () => {
  function Form() {
    const [value, setValue] = useState("");
    return (
      <>
        <p>Applied: {value || "all"}</p>
        <FilterDialog
          count={value ? 1 : 0}
          onClear={() => setValue("")}
          onApply={(data) => setValue(String(data.get("state")))}
        >
          <label>
            Estado
            <input name="state" defaultValue={value} />
          </label>
        </FilterDialog>
      </>
    );
  }
  render(<Form />);
  fireEvent.click(screen.getByRole("button", { name: "Filtros · 0" }));
  fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "sent" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  expect(screen.getByText("Applied: all")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Filtros · 0" }));
  expect((screen.getByLabelText("Estado") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "sent" } });
  fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
  expect(screen.getByText("Applied: sent")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Filtros · 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Limpiar filtros" }));
  expect(screen.getByText("Applied: all")).toBeTruthy();
});
it("uses complete local calendar days and rejects impossible added dates", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const start = addedDayBoundary("2026-03-08");
    const end = addedDayBoundary("2026-03-08", true);
    expect(Date.parse(end) - Date.parse(start)).toBe(23 * 3600000);
    expect(() => addedDayBoundary("2026-02-30")).toThrow();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
it("releases private PDF blobs on switch and close, retains retry and does not fetch DOCX", async () => {
  const create = vi.fn().mockReturnValue("blob:private-test");
  const release = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = release;
    },
  );
  const fetch = vi.spyOn(files, "fetchResume").mockResolvedValue({
    type: "application/pdf",
    arrayBuffer: async () => new ArrayBuffer(8),
  } as Blob);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const view = render(<ResumeFile id="pdf" mediaType="application/pdf" />);
  await screen.findByRole("link", { name: "Abrir PDF" });
  expect(screen.getByRole("link", { name: "Abrir PDF" }).getAttribute("href")).toBe(
    "blob:private-test",
  );
  expect(pdfjs.getDocument).toHaveBeenLastCalledWith(
    expect.objectContaining({ wasmUrl: "/pdfjs/wasm/" }),
  );
  const destroyed = pdfjs.destroy.mock.calls.length;
  view.rerender(
    <ResumeFile
      id="docx"
      mediaType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    />,
  );
  expect(release).toHaveBeenCalledWith("blob:private-test");
  expect(pdfjs.destroy).toHaveBeenCalledTimes(destroyed + 1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/vista previa de DOCX/)).toBeTruthy();
  fetch.mockRejectedValueOnce(new Error("La descarga expiró."));
  view.rerender(<ResumeFile id="expired" mediaType="application/pdf" />);
  await screen.findByText("La descarga expiró.");
  fireEvent.click(screen.getByRole("button", { name: "Reintentar vista previa" }));
  await screen.findByRole("link", { name: "Abrir PDF" });
  view.unmount();
  expect(release).toHaveBeenCalledTimes(2);
});
it("aborts a PDF download that is still in flight when the preview closes and ignores its late bytes", async () => {
  const create = vi.fn().mockReturnValue("blob:late");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = vi.fn();
    },
  );
  let deliver = (_blob: Blob) => {};
  let signal: AbortSignal | undefined;
  vi.spyOn(files, "fetchResume").mockImplementation((_id, received) => {
    signal = received;
    return new Promise<Blob>((resolve) => (deliver = resolve));
  });
  const opened = pdfjs.getDocument.mock.calls.length;
  const view = render(<ResumeFile id="late" mediaType="application/pdf" />);
  await waitFor(() => expect(signal).toBeDefined());
  view.unmount();
  expect(signal?.aborted).toBe(true);
  deliver({ type: "application/pdf", arrayBuffer: async () => new ArrayBuffer(8) } as Blob);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(create).not.toHaveBeenCalled();
  expect(pdfjs.getDocument).toHaveBeenCalledTimes(opened);
});
it("validates VAPID, reports safe failures and retries an uncertain registration with its original key", async () => {
  const key = btoa(String.fromCharCode(4, ...Array<number>(64).fill(1)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  expect(publicPushKey(key).length).toBe(65);
  for (const bad of [undefined, "bad", "A".repeat(87)])
    expect(() => publicPushKey(bad)).toThrow(/clave pública/);
  const permission = vi.fn();
  const subscription = {
    endpoint: "https://fcm.googleapis.com/test",
    options: { applicationServerKey: publicPushKey(key).buffer },
    toJSON: () => ({ keys: { p256dh: "test", auth: "test" } }),
  };
  const subscribe = vi.fn().mockResolvedValue(subscription);
  const registration = {
    pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription), subscribe },
  };
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { permission: "granted", requestPermission: permission });
  vi.stubGlobal("navigator", {
    onLine: true,
    userAgent: "test",
    serviceWorker: {
      register: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
    },
  });
  const invoke = vi.fn().mockResolvedValue({ data: { public_key: key }, error: null });
  vi.spyOn(api, "requireSupabase").mockReturnValue({ functions: { invoke } } as never);
  const operation = vi
    .spyOn(api, "operation")
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValue({} as never);
  await expect(subscribePush()).rejects.toThrow(/solicitud queda guardada/);
  const first = operation.mock.calls[0]?.[1];
  expect(await stored(`push-intent:${api.ownerId}`, "get")).toBeTruthy();
  await subscribePush();
  expect(operation.mock.calls[1]?.[1]).toEqual(first);
  expect(operation).toHaveBeenCalledTimes(2);
  expect(await stored(`push-intent:${api.ownerId}`, "get")).toBeUndefined();
  expect(permission).not.toHaveBeenCalled();
  for (const [error, message] of [
    [{ context: { status: 401 } }, /sesión/],
    [{ context: { status: 503 } }, /configuración/],
    [{}, /conectar/],
  ] as const) {
    invoke.mockResolvedValueOnce({ error });
    await expect(subscribePush()).rejects.toThrow(message);
  }
  vi.stubGlobal("Notification", { permission: "denied", requestPermission: permission });
  await expect(subscribePush()).rejects.toThrow(/no autorizadas/);
  vi.stubGlobal("PushManager", undefined);
  delete (window as unknown as Record<string, unknown>).PushManager;
  await expect(subscribePush()).rejects.toThrow(/no admite/);
  await waitFor(() => expect(permission).not.toHaveBeenCalled());
});
it("prompts once from the default permission and rotates a subscription made with an old key", async () => {
  const encode = (fill: number) =>
    btoa(String.fromCharCode(4, ...Array<number>(64).fill(fill)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  const [current, old] = [encode(2), encode(3)];
  const unsubscribe = vi.fn().mockResolvedValue(true);
  const stale = {
    endpoint: "https://push.example/old",
    options: { applicationServerKey: publicPushKey(old).buffer },
    unsubscribe,
  };
  const fresh = {
    endpoint: "https://push.example/new",
    options: { applicationServerKey: publicPushKey(current).buffer },
    toJSON: () => ({ keys: { p256dh: "p", auth: "a" } }),
  };
  const subscribe = vi.fn().mockResolvedValue(fresh);
  const registration = {
    pushManager: { getSubscription: vi.fn().mockResolvedValue(stale), subscribe },
  };
  const requestPermission = vi.fn().mockResolvedValue("granted");
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { permission: "default", requestPermission });
  vi.stubGlobal("navigator", {
    onLine: true,
    userAgent: "test",
    serviceWorker: {
      register: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
    },
  });
  vi.spyOn(api, "requireSupabase").mockReturnValue({
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: { public_key: current }, error: null }),
    },
  } as never);
  const operation = vi.spyOn(api, "operation").mockResolvedValue({} as never);
  await subscribePush();
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(operation.mock.calls.map(([name, input]) => [name, input?.endpoint])).toEqual([
    ["push.deactivate", "https://push.example/old"],
    ["push.subscribe", "https://push.example/new"],
  ]);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: publicPushKey(current),
  });
  requestPermission.mockResolvedValueOnce("denied");
  await expect(subscribePush()).rejects.toThrow(/no autorizadas/);
  expect(requestPermission).toHaveBeenCalledTimes(2);
  expect(subscribe).toHaveBeenCalledTimes(1);
});
it("closes a sheet on a genuine backdrop click but not after dragging out of a field", () => {
  const stop = dismissDialogs();
  render(
    <dialog aria-label="Hoja">
      <input aria-label="Campo" />
    </dialog>,
  );
  const dialog = screen.getByRole("dialog", { hidden: true }) as HTMLDialogElement;
  dialog.showModal();
  vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 200, 200));
  // jsdom has no PointerEvent; a MouseEvent of the same type carries the coordinates.
  const press = (target: Element, x: number) =>
    fireEvent(target, new MouseEvent("pointerdown", { bubbles: true, clientX: x, clientY: x }));
  press(screen.getByLabelText("Campo"), 150);
  fireEvent.click(dialog, { clientX: 10, clientY: 10 });
  expect(dialog.open).toBe(true);
  press(dialog, 10);
  fireEvent.click(dialog, { clientX: 10, clientY: 10 });
  expect(dialog.open).toBe(false);
  stop();
});
it("updates the connection and sync status without setting state while other screens render", async () => {
  const errors = vi.spyOn(console, "error");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Screen({ name }: { name: string }) {
    const query = useQuery({ queryKey: [name], queryFn: async () => `${name} listo` });
    return <p>{query.data ?? "cargando"}</p>;
  }
  // Screens render before the status bar, like the routed screen inside the layout.
  const shell = (children: React.ReactNode) => (
    <QueryClientProvider client={client}>
      {children}
      <ConnectionStatus online />
      <SyncStatus online={false} />
    </QueryClientProvider>
  );
  const view = render(shell(<Screen name="a" />));
  await screen.findByText("a listo");
  await screen.findByText(/Datos actualizados/);
  // A refetch leaves a pending status update; a screen mounting in the same render then builds a
  // new query, and its cache notification must not set the status bar's state mid-render.
  act(() => {
    void client.invalidateQueries();
    view.rerender(
      shell(
        <>
          <Screen name="b" />
          <Screen name="a" />
        </>,
      ),
    );
  });
  await screen.findByText("b listo");
  expect(
    errors.mock.calls.filter(([message]) => String(message).includes("Cannot update a component")),
  ).toEqual([]);
  client.clear();
});
