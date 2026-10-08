import { EmailNotifications, exportData } from "../src/screens/Settings";
import { Consent, consentRedirect } from "../src/screens/Consent";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import {
  persistQueryClientSave,
  persistQueryClientRestore,
} from "@tanstack/react-query-persist-client";
import { followups } from "../src/shared/state/model";
import { namespace, persister, schemaVersion, stored } from "../src/shared/state/storage";
import {
  makeClient,
  findCurrent,
  resumeEdits,
  savedNotice,
  type Edit,
} from "../src/shared/state/crm";
import { Copy, Editor } from "../src/shared/ui/controls";
import * as api from "../src/shared/api/client";
const owner = "00000000-0000-4000-8000-000000000000";
const id = "22222222-2222-4222-8222-222222222222";
let order = 0;
function edit(key: string, entity = id): Edit {
  return {
    order: ++order,
    operation: "contacts.upsert",
    entity_id: entity,
    id: key,
    input: { id: entity, expected_version: 2, idempotency_key: key, name: "Mi borrador" },
  };
}
describe("private frontend contract", () => {
  it("saves email opt-in only on an explicit online action, with version and idempotency, preserving state on errors", async () => {
    onlineManager.setOnline(true);
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const rpc = vi.fn().mockResolvedValue({ data: { enabled: false, version: 0 }, error: null });
    vi.spyOn(api, "requireSupabase").mockReturnValue({ rpc } as unknown as ReturnType<
      typeof api.requireSupabase
    >);
    const client = makeClient();
    const app = render(
      <QueryClientProvider client={client}>
        <EmailNotifications />
      </QueryClientProvider>,
    );
    const enable = await screen.findByRole("button", { name: "Activar correo" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("crm_email_preferences", { p_input: {} });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "fetch failed" } });
    fireEvent.click(enable);
    await screen.findByText(
      "Resultado sin confirmar. La solicitud original se conserva para reintentar.",
    );
    expect(screen.getByText("Correo desactivado.")).toBeTruthy();
    const firstWrite = rpc.mock.calls[1]?.[1].p_input;
    expect(firstWrite).toEqual({
      enabled: true,
      expected_version: 0,
      idempotency_key: expect.any(String),
    });
    expect(firstWrite.idempotency_key).toMatch(/^[\da-f-]{36}$/i);
    rpc.mockResolvedValueOnce({ data: { enabled: true, version: 1 }, error: null });
    fireEvent.click(screen.getByRole("button", { name: "Reintentar preferencia original" }));
    await screen.findByText("Correo activado.");
    expect(rpc.mock.calls[2]?.[1].p_input).toEqual(firstWrite);
    // A version conflict is definitive (the RPC writes nothing): release the intent and refetch.
    rpc
      .mockResolvedValueOnce({
        data: {
          error: {
            code: "CONFLICT",
            message: "Preference changed",
            field: "expected_version",
            retryable: false,
            current_version: 4,
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { enabled: false, version: 4 }, error: null });
    fireEvent.click(screen.getByRole("button", { name: "Desactivar correo" }));
    await screen.findByText(/No se aplicó tu cambio \(desactivar correo\)/);
    await screen.findByText("Correo desactivado.");
    expect(screen.queryByRole("button", { name: "Reintentar preferencia original" })).toBeNull();
    rpc.mockResolvedValueOnce({ data: { enabled: true, version: 5 }, error: null });
    fireEvent.click(screen.getByRole("button", { name: "Activar correo" }));
    await screen.findByText("Correo activado.");
    expect(rpc).toHaveBeenLastCalledWith("crm_email_preferences", {
      p_input: { enabled: true, expected_version: 4, idempotency_key: expect.any(String) },
    });
    online.mockReturnValue(false);
    app.rerender(
      <QueryClientProvider client={client}>
        <EmailNotifications />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Desactivar correo" }).disabled,
    ).toBe(true);
    app.unmount();
    client.clear();
  });
  it("announces suspected duplicates without claiming a merge or losing ordinary success", () => {
    expect(savedNotice({ duplicate_hints: [id] })).toContain("Posibles duplicados: 1");
    expect(savedNotice({ duplicate_hints: [] })).toBe("Cambio guardado.");
    expect(savedNotice(null)).toBe("Cambio guardado.");
  });
  it("identifies all four followup classes without treating queued outreach as delivery", () => {
    const now = Date.parse("2026-10-03T12:00:00Z");
    const jobs = [{ id, version: 1, stage: "applied" }];
    const contacts = [
      { id: "a", version: 1, status: "uncontacted", job_id: id },
      { id: "b", version: 1, status: "connected", queued_at: "2026-10-02" },
      { id: "c", version: 1, status: "invited", invite_at: "2026-09-25" },
      { id: "d", version: 1, status: "messaged", last_interacted_at: "2026-09-27" },
      { id: "e", version: 1, status: "invited", invite_at: "2026-10-02" },
      { id: "f", version: 1, status: "uncontacted", job_id: "radar" },
    ];
    expect(followups(contacts, jobs, now).map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("isolates IndexedDB by owner/schema and clears only the selected namespace", async () => {
    await stored(namespace(owner), "put", { private: "owner" });
    await stored(namespace("other"), "put", { private: "other" });
    expect(await stored(namespace(owner), "get")).toEqual({ private: "owner" });
    await persister(owner).removeClient();
    expect(await stored(namespace(owner), "get")).toBeUndefined();
    expect(await stored(namespace("other"), "get")).toEqual({ private: "other" });
  });
  it("drops successful edits from memory and keeps the schema version that names stored drafts", async () => {
    onlineManager.setOnline(true);
    vi.spyOn(api, "operation").mockResolvedValue({ id, version: 3 });
    const client = makeClient();
    await client
      .getMutationCache()
      .build(client, { mutationKey: ["ordinary-edit"], scope: { id } })
      .execute(edit(crypto.randomUUID()));
    await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
    expect(
      schemaVersion,
      "drafts and recovery are stored under crm:<owner>:v<schema>; migrate old-version drafts before bumping",
    ).toBe(1);
  });
  it("writes a burst of cache snapshots as at most two IndexedDB puts, keeping the newest", async () => {
    const storage = persister(owner + "burst");
    const opens = vi.spyOn(indexedDB, "open");
    const snapshot = (n: number) =>
      ({ timestamp: n, buster: "1", clientState: { queries: [], mutations: [] } }) as never;
    await Promise.all([1, 2, 3, 4, 5].map((n) => storage.persistClient(snapshot(n))));
    expect(opens.mock.calls.length).toBeLessThanOrEqual(2);
    expect(await storage.restoreClient()).toMatchObject({ timestamp: 5 });
    await storage.removeClient();
  });
  it("restores paused scoped edits with registered defaults and original idempotency keys", async () => {
    onlineManager.setOnline(false);
    const first = makeClient();
    const storage = persister(owner + "replay");
    const key = crypto.randomUUID();
    const pending = first
      .getMutationCache()
      .build(first, { mutationKey: ["ordinary-edit"], scope: { id } });
    void pending.execute(edit(key)).catch(() => {});
    await waitFor(() => expect(pending.state.isPaused).toBe(true));
    await persistQueryClientSave({
      queryClient: first,
      persister: storage,
      buster: "2",
      dehydrateOptions: { shouldDehydrateMutation: () => true },
    });
    const restored = makeClient();
    await persistQueryClientRestore({ queryClient: restored, persister: storage, buster: "2" });
    expect(restored.getMutationCache().getAll()[0]?.options.scope).toEqual({ id });
    const restoredMutation = restored.getMutationCache().getAll()[0];
    if (!restoredMutation) throw new Error("Mutation was not restored");
    expect((restoredMutation.state.variables as Edit).input.idempotency_key).toBe(key);
    const rpc = vi.spyOn(api, "operation").mockResolvedValue({ id, version: 3 });
    expect(rpc).not.toHaveBeenCalled();
    onlineManager.setOnline(true);
    await restored.resumePausedMutations();
    expect(rpc).toHaveBeenCalledWith(
      "contacts.upsert",
      expect.objectContaining({ idempotency_key: key, expected_version: 2 }),
    );
    await storage.removeClient();
    first.clear();
    restored.clear();
  });
  it("resumes an edit persisted mid-request after reload and then runs the next edit for that record", async () => {
    onlineManager.setOnline(true);
    const first = makeClient();
    const storage = persister(owner + "in-flight");
    const [key, later] = [crypto.randomUUID(), crypto.randomUUID()];
    vi.spyOn(api, "operation").mockReturnValue(new Promise(() => {}));
    const inFlight = first
      .getMutationCache()
      .build(first, { mutationKey: ["ordinary-edit"], scope: { id } });
    void inFlight.execute(edit(key)).catch(() => {});
    await waitFor(() =>
      expect(inFlight.state).toMatchObject({ status: "pending", isPaused: false }),
    );
    await persistQueryClientSave({
      queryClient: first,
      persister: storage,
      buster: "2",
      dehydrateOptions: { shouldDehydrateMutation: (m) => m.state.status !== "success" },
    });
    const restored = makeClient();
    await persistQueryClientRestore({ queryClient: restored, persister: storage, buster: "2" });
    const rpc = vi.spyOn(api, "operation").mockResolvedValue({ id, version: 3 });
    // Vitest 4+ reuses an existing spy without clearing its history; count only resumed calls.
    rpc.mockClear();
    const next = restored
      .getMutationCache()
      .build(restored, { mutationKey: ["ordinary-edit"], scope: { id } });
    const queued = next.execute(edit(later)).catch(() => {});
    await resumeEdits(restored);
    await queued;
    expect(rpc.mock.calls.map((call) => call[1]?.idempotency_key)).toEqual([key, later]);
    await storage.removeClient();
    first.clear();
    restored.clear();
  });
  it("replays two queued edits of one record against a version-checking server, still conflicting on outside changes", async () => {
    onlineManager.setOnline(true);
    let version = 2;
    const rpc = vi.spyOn(api, "operation").mockImplementation(async (_name, input) => {
      if (input?.expected_version !== version) throw new api.OperationError("CONFLICT", "stale");
      return { id, version: ++version } as never;
    });
    const client = makeClient();
    const run = (key: string) =>
      client
        .getMutationCache()
        .build(client, { mutationKey: ["ordinary-edit"], scope: { id } })
        .execute(edit(key));
    await Promise.all([run(crypto.randomUUID()), run(crypto.randomUUID())]);
    expect(rpc.mock.calls.map((call) => call[1]?.expected_version)).toEqual([2, 3]);
    version = 10;
    await expect(run(crypto.randomUUID())).rejects.toMatchObject({ code: "CONFLICT" });
    client.clear();
  });
  it("preserves a conflict and blocks dependent edits while independent records continue", async () => {
    onlineManager.setOnline(true);
    const client = makeClient();
    const rpc = vi
      .spyOn(api, "operation")
      .mockRejectedValueOnce(new api.OperationError("CONFLICT", "Versión obsoleta"))
      .mockResolvedValue({ id: "other", version: 2 });
    const first = client
      .getMutationCache()
      .build(client, { mutationKey: ["ordinary-edit"], scope: { id } });
    await expect(first.execute(edit("a"))).rejects.toMatchObject({ code: "CONFLICT" });
    const second = client
      .getMutationCache()
      .build(client, { mutationKey: ["ordinary-edit"], scope: { id } });
    await expect(second.execute(edit("b"))).rejects.toMatchObject({ code: "BLOCKED" });
    expect((first.state.variables as Edit).input.name).toBe("Mi borrador");
    const independent = client
      .getMutationCache()
      .build(client, { mutationKey: ["ordinary-edit"], scope: { id: "other" } });
    await independent.execute(edit("c", "other"));
    expect(rpc).toHaveBeenCalledTimes(2);
    // The older conflicting edit may be explicitly reapplied while its later BLOCKED draft survives.
    const original = first.state.variables as Edit;
    client.getMutationCache().remove(first);
    const reapplied = client
      .getMutationCache()
      .build(client, { mutationKey: ["ordinary-edit"], scope: { id } });
    await reapplied.execute({
      ...original,
      id: "new-key",
      input: { ...original.input, expected_version: 3, idempotency_key: "new-key" },
    });
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(second.state.status).toBe("error");
    expect((second.state.variables as Edit).input.name).toBe("Mi borrador");
    client.clear();
  });
  it("paginates conflict lookup beyond the first fifty records", async () => {
    const rpc = vi
      .spyOn(api, "operation")
      .mockResolvedValueOnce({
        items: [{ id: "other", version: 1 }],
        has_more: true,
        next_cursor: "next",
      })
      .mockResolvedValueOnce({
        items: [{ id, version: 7, name: "Servidor" }],
        has_more: false,
        next_cursor: null,
      });
    expect(await findCurrent("contacts.upsert", id)).toMatchObject({ id, version: 7 });
    expect(rpc).toHaveBeenLastCalledWith("contacts.search", { limit: 50, cursor: "next" });
  });
  it("native form has labels, preserves validation errors, and cancels without writing", async () => {
    const rpc = vi.spyOn(api, "operation");
    const client = makeClient();
    render(
      <QueryClientProvider client={client}>
        <Editor
          entity="jobs"
          operation="jobs.upsert"
          title="Agregar oportunidad"
          fields={[
            { name: "title", label: "Puesto", required: true },
            { name: "company_id", label: "Empresa", required: true },
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Agregar oportunidad" }));
    expect(screen.getByRole("dialog").hasAttribute("open")).toBe(true);
    expect(screen.getByLabelText("Puesto").getAttribute("required")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(rpc).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { hidden: true }).hasAttribute("open")).toBe(false);
    client.clear();
  });
  it("clipboard failure exposes manual selection without claiming successful copying", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(<Copy id={id} value="Borrador" />);
    fireEvent.click(screen.getByRole("button", { name: "Copiar texto" }));
    await waitFor(() => expect(screen.getByLabelText("Copia manual")).toBeTruthy());
    expect((screen.getByLabelText("Copia manual") as HTMLTextAreaElement).value).toBe("Borrador");
  });
});

describe("owner OAuth consent", () => {
  it("restricts redirects to HTTPS or loopback HTTP without credentials", () => {
    expect(consentRedirect("https://client.example/callback?code=opaque")).toContain(
      "https://client.example/",
    );
    expect(consentRedirect("http://127.0.0.1:3000/callback")).toContain("http://127.0.0.1:3000/");
    for (const url of [
      "javascript:alert(1)",
      "http://remote.example/callback",
      "https://user:pass@client.example/",
    ])
      expect(() => consentRedirect(url)).toThrow();
  });
  it("rejects missing, oversized or path-like authorization identifiers before SDK calls", async () => {
    const getDetails = vi.fn();
    vi.spyOn(api, "requireSupabase").mockReturnValue({
      auth: { oauth: { getAuthorizationDetails: getDetails } },
    } as unknown as ReturnType<typeof api.requireSupabase>);
    for (const value of ["", "a".repeat(129), "../consent"]) {
      history.replaceState({}, "", `/oauth/consent?authorization_id=${encodeURIComponent(value)}`);
      const view = render(<Consent />);
      await screen.findByRole("alert");
      expect(getDetails).not.toHaveBeenCalled();
      view.unmount();
    }
    history.replaceState({}, "", "/");
  });
  it("loads only owner details and requires an explicit consent decision", async () => {
    const authorizationId = "77ajvdb36wnixgboklw7esu5eqi7tsz7";
    history.replaceState({}, "", `/oauth/consent?authorization_id=${authorizationId}`);
    const approve = vi.fn().mockResolvedValue({ data: null, error: new Error("denied") });
    const deny = vi.fn().mockResolvedValue({ data: null, error: new Error("denied") });
    const details = {
      authorization_id: authorizationId,
      redirect_uri: "https://client.example/callback",
      client: { id: owner, name: "Mi cliente" },
      scope: "openid email",
      user: { id: api.ownerId, email: "owner@example.com" },
    };
    vi.spyOn(api, "requireSupabase").mockReturnValue({
      auth: {
        oauth: {
          getAuthorizationDetails: vi.fn().mockResolvedValue({ data: details, error: null }),
          approveAuthorization: approve,
          denyAuthorization: deny,
        },
      },
    } as unknown as ReturnType<typeof api.requireSupabase>);
    render(<Consent />);
    await screen.findByRole("heading", { name: "Mi cliente" });
    expect(approve).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rechazar acceso" }));
    await waitFor(() =>
      expect(deny).toHaveBeenCalledWith(authorizationId, { skipBrowserRedirect: true }),
    );
    expect(approve).not.toHaveBeenCalled();
    history.replaceState({}, "", "/");
  });
});

describe("complete owner backup", () => {
  it("exports beyond100 records and keeps working when the server truncates each request", async () => {
    const selected: Record<string, string> = {};
    const client = {
      from: (table: string) => {
        const query = {
          select: (columns: string) => {
            selected[table] = columns;
            return query;
          },
          eq: () => query,
          order: () => query,
          range: async (from: number) => ({
            error: null,
            data:
              table === "jobs"
                ? Array.from({ length: Math.max(0, Math.min(20, 125 - from)) }, (_, i) => ({
                    id: `job-${from + i}`,
                    user_id: api.ownerId,
                    version: 1,
                  }))
                : [],
          }),
        };
        return query;
      },
    };
    vi.spyOn(api, "requireSupabase").mockReturnValue(
      client as unknown as ReturnType<typeof api.requireSupabase>,
    );
    const exported = await exportData();
    expect(exported.records.jobs).toHaveLength(125);
    expect(selected.resumes).not.toBe("*");
    expect(selected.resumes).not.toContain("storage_path");
    expect(selected.mutation_receipts).toBe("*");
  });
});
