import { followups } from "../src/shared/state/model";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../src/shared/api/client";
import * as storage from "../src/shared/state/storage";
import { recoverySnapshot, retainRecovery } from "../src/shared/state/recovery";
import {
  CrmProvider,
  exportDrafts,
  makeClient,
  NoticeBanner,
  savedNotice,
  useExactWrite,
  useEdit,
  useRecords,
  useRestricted,
} from "../src/shared/state/crm";
import { Editor, nowLocal, options, safeExternalUrl } from "../src/shared/ui/controls";
import { interviewInstant, localInstants, zonedLocal } from "../src/shared/ui/interview-time";
import { Dashboard } from "../src/screens/Dashboard";
import { OutreachCard } from "../src/screens/Outreach";
import { agendaOrder } from "../src/screens/Interviews";
import { rebaseDraft, workProfile } from "../src/screens/Automation";
import type { Policy, Work } from "@crm/contracts";
import type { RecordData } from "../src/shared/api/client";
import { ContactErasure } from "../src/shared/ui/contact-erasure";
import { JevClassification } from "../src/shared/ui/JevClassification";

const id = "00000000-0000-4000-8000-000000000001";
afterEach(() => vi.useRealTimers());
function provider(children: React.ReactNode) {
  const client = makeClient();
  return {
    client,
    ...render(<QueryClientProvider client={client}>{children}</QueryClientProvider>),
  };
}
it("resolves selected-zone local time, rejects DST gaps and requires an overlap choice", () => {
  expect(interviewInstant("2026-10-04T09:00", "America/New_York", "")).toBe(
    "2026-10-04T13:00:00.000Z",
  );
  expect(zonedLocal("2026-10-04T13:00:00Z", "America/New_York")).toBe("2026-10-04T09:00");
  expect(localInstants("2026-03-08T02:30", "America/New_York")).toEqual([]);
  expect(() => interviewInstant("2026-03-08T02:30", "America/New_York", "")).toThrow(/no existe/);
  expect(() => interviewInstant("2026-11-01T01:30", "America/New_York", "")).toThrow(/dos veces/);
  expect(interviewInstant("2026-11-01T01:30", "America/New_York", "first")).toBe(
    "2026-11-01T05:30:00.000Z",
  );
  expect(interviewInstant("2026-11-01T01:30", "America/New_York", "second")).toBe(
    "2026-11-01T06:30:00.000Z",
  );
  expect(interviewInstant("2026-10-06T10:00", "America/Mexico_City", "second")).toBe(
    "2026-10-06T16:00:00.000Z",
  );
  expect(() => localInstants("2026-02-30T09:00", "UTC")).not.toThrow();
  expect(localInstants("2026-02-30T09:00", "UTC")).toEqual([]);
});
it("retains exact uncertain request through unmount and does not dispatch after reservation failure", async () => {
  const rpc = vi
    .spyOn(api, "operation")
    .mockRejectedValueOnce(new Error("ACK perdido"))
    .mockResolvedValue({ id, version: 2 });
  function Controls() {
    const write = useExactWrite("test");
    return (
      <>
        <button onClick={() => void write.write("contacts.archive", { id, expected_version: 1 })}>
          Enviar
        </button>
        {write.intent && <button onClick={() => void write.retry()}>Reintentar exacto</button>}
        {write.error && <p>{write.error}</p>}
      </>
    );
  }
  const view = provider(<Controls />);
  fireEvent.click(screen.getByText("Enviar"));
  await screen.findByText("ACK perdido");
  const first = rpc.mock.calls[0]?.[1];
  expect(recoverySnapshot()["intent:test"]).toMatchObject({ input: first });
  view.unmount();
  const next = provider(<Controls />);
  fireEvent.click(screen.getByText("Reintentar exacto"));
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  expect(rpc.mock.calls[1]?.[1]).toEqual(first);
  await waitFor(() => expect(recoverySnapshot()["intent:test"]).toBeUndefined());
  next.unmount();
  const blocked = vi.spyOn(storage, "stored").mockRejectedValue(new Error("IndexedDB bloqueado"));
  provider(<Controls />);
  fireEvent.click(screen.getByText("Enviar"));
  await screen.findByText("IndexedDB bloqueado");
  expect(rpc).toHaveBeenCalledTimes(2);
  blocked.mockRestore();
});
it("retains failed durable deletion and keeps namespaces distinct", async () => {
  await retainRecovery("intent:retain", { id });
  vi.spyOn(storage, "stored").mockRejectedValueOnce(new Error("blocked"));
  await expect(retainRecovery("intent:retain", null)).rejects.toThrow("blocked");
  expect(recoverySnapshot()["intent:retain"]).toEqual({ id });
  expect(storage.namespace("owner-one")).not.toBe(storage.namespace("owner-two"));
});
it("retains form fields and original baseline across navigation and polling, including empty participants", async () => {
  const calls = vi.spyOn(api, "operation").mockResolvedValue({ id, version: 5 });
  const fields = [
    { name: "notes", label: "Notas" },
    {
      name: "interviewer_ids",
      label: "Participantes",
      multiple: true,
      options: [{ value: id, label: "María" }],
    },
  ];
  const first = provider(
    <Editor
      entity="interviews"
      operation="interviews.upsert"
      record={{ id, version: 4, notes: "Antes", interviewer_ids: [id] }}
      title="Editar"
      fields={fields}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Editar" }));
  fireEvent.change(screen.getByLabelText("Notas"), { target: { value: "Mi borrador" } });
  const select = screen.getByLabelText("Participantes") as HTMLSelectElement;
  select.options[0]!.selected = false;
  fireEvent.change(select);
  await waitFor(() =>
    expect(recoverySnapshot()[`form:interviews:${id}:interviews.upsert:Editar`]).toBeTruthy(),
  );
  first.unmount();
  provider(
    <Editor
      entity="interviews"
      operation="interviews.upsert"
      record={{ id, version: 5, notes: "Actualizado", interviewer_ids: [id] }}
      title="Editar"
      fields={fields}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Editar" }));
  expect((screen.getByLabelText("Notas") as HTMLInputElement).value).toBe("Mi borrador");
  fireEvent.submit(screen.getByRole("form", { name: "Editar" }));
  await waitFor(() => expect(calls).toHaveBeenCalled());
  expect(calls.mock.calls[0]?.[1]).toMatchObject({
    expected_version: 4,
    notes: "Mi borrador",
    interviewer_ids: [],
  });
});
it("keeps unresolved recorded participants and permits canonical decimal controls", async () => {
  const fields = [
    { name: "interviewer_ids", label: "Participantes", multiple: true, options: [] },
    { name: "fit", label: "Afinidad", type: "number", max: 10 },
  ];
  provider(
    <Editor
      entity="interviews"
      operation="interviews.upsert"
      record={{ id, version: 1, interviewer_ids: [id], fit: 7.5 }}
      title="Editar relación"
      fields={fields}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Editar relación" }));
  expect(
    (screen.getByLabelText("Participantes") as HTMLSelectElement).selectedOptions[0]?.value,
  ).toBe(id);
  const fit = screen.getByLabelText("Afinidad") as HTMLInputElement;
  expect(fit.step).toBe("any");
  expect(fit.checkValidity()).toBe(true);
  fit.value = "10.5";
  expect(fit.checkValidity()).toBe(false);
  expect(safeExternalUrl("https://social.example.invalid/example")).toBeTruthy();
  expect(safeExternalUrl("https://user:pass@example.invalid")).toBeNull();
  expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
});
it("does not accept a future time for a date that records what already happened", () => {
  provider(
    <Editor
      entity="contacts"
      operation="contacts.upsert"
      title="Registrar invitación"
      fields={[
        {
          name: "invite_at",
          label: "Invitación enviada realmente el",
          type: "datetime-local",
          max: nowLocal(),
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Registrar invitación" }));
  const input = screen.getByLabelText("Invitación enviada realmente el") as HTMLInputElement;
  input.value = "2999-01-01T09:00";
  expect(input.checkValidity()).toBe(false);
  input.value = "2026-01-01T09:00";
  expect(input.checkValidity()).toBe(true);
});
it("saves a create form once even when it is submitted twice before it is queued", async () => {
  const calls = vi.spyOn(api, "operation").mockResolvedValue({ id, version: 1 });
  provider(
    <Editor
      entity="companies"
      operation="companies.upsert"
      title="Agregar empresa de prueba"
      fields={[{ name: "name", label: "Nombre", required: true }]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Agregar empresa de prueba" }));
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Acme" } });
  const form = screen.getByRole("form", { name: "Agregar empresa de prueba" });
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => expect(calls).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(calls).toHaveBeenCalledTimes(1);
});
it("keeps Postgres '+00:00' timestamps when an unrelated field is edited", async () => {
  const calls = vi.spyOn(api, "operation").mockResolvedValue({ id, version: 9 });
  const contact = provider(
    <Editor
      entity="contacts"
      operation="contacts.upsert"
      record={{
        id,
        version: 3,
        notes: "Antes",
        invite_at: "2026-10-01T15:30:00+00:00",
        last_interacted_at: "2026-10-02T08:05:00.123456+00:00",
      }}
      title="Editar fechas de contacto"
      fields={[
        { name: "notes", label: "Notas", type: "textarea" },
        { name: "invite_at", label: "Invitación", type: "datetime-local" },
        { name: "last_interacted_at", label: "Última interacción", type: "datetime-local" },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Editar fechas de contacto" }));
  expect((screen.getByLabelText("Invitación") as HTMLInputElement).value).not.toBe("");
  fireEvent.change(screen.getByLabelText("Notas"), { target: { value: "Solo notas" } });
  fireEvent.submit(screen.getByRole("form", { name: "Editar fechas de contacto" }));
  await waitFor(() => expect(calls).toHaveBeenCalledTimes(1));
  expect(calls.mock.calls[0]?.[1]).toMatchObject({
    notes: "Solo notas",
    invite_at: "2026-10-01T15:30:00.000Z",
    last_interacted_at: "2026-10-02T08:05:00.000Z",
  });
  contact.unmount();
  provider(
    <Editor
      entity="interviews"
      operation="interviews.upsert"
      record={{
        id,
        version: 2,
        notes: "Antes",
        timezone: "America/Mexico_City",
        scheduled_at: "2026-10-08T16:00:00+00:00",
      }}
      title="Editar fecha de entrevista"
      fields={[
        { name: "scheduled_at", label: "Fecha y hora local", type: "datetime-local" },
        { name: "timezone", label: "Zona horaria IANA", required: true },
        { name: "notes", label: "Notas", type: "textarea" },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Editar fecha de entrevista" }));
  expect((screen.getByLabelText("Fecha y hora local") as HTMLInputElement).value).toBe(
    "2026-10-08T10:00",
  );
  fireEvent.change(screen.getByLabelText("Notas"), { target: { value: "Solo notas" } });
  fireEvent.submit(screen.getByRole("form", { name: "Editar fecha de entrevista" }));
  await waitFor(() => expect(calls).toHaveBeenCalledTimes(2));
  expect(calls.mock.calls[1]?.[1]).toMatchObject({
    notes: "Solo notas",
    scheduled_at: "2026-10-08T16:00:00.000Z",
  });
});
it("cancels only a queued reminder, with a reason, its version and a confirmation", async () => {
  const event = "00000000-0000-4000-8000-0000000000e2";
  const calls = vi
    .spyOn(api, "operation")
    .mockResolvedValue({ id: event, version: 5, state: "cancelled" } as never);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  function Card({ record }: { record: RecordData }) {
    return <OutreachCard record={record} name="Ana" restricted={useRestricted()} />;
  }
  const view = provider(<Card record={{ id: event, version: 1, state: "draft", body: "Hola" }} />);
  expect(screen.queryByRole("button", { name: "Cancelar recordatorio" })).toBeNull();
  view.rerender(
    <QueryClientProvider client={view.client}>
      <Card record={{ id: event, version: 4, state: "queued", body: "Hola" }} />
    </QueryClientProvider>,
  );
  const reason = screen.getByLabelText("Motivo de la cancelación") as HTMLInputElement;
  reason.value = "   ";
  expect(reason.checkValidity()).toBe(false);
  fireEvent.change(reason, { target: { value: " Recordatorio duplicado " } });
  fireEvent.click(screen.getByRole("button", { name: "Cancelar recordatorio" }));
  await waitFor(() =>
    expect(calls).toHaveBeenCalledWith("outreach.cancel", {
      id: event,
      expected_version: 4,
      reason: "Recordatorio duplicado",
      idempotency_key: expect.stringMatching(/^[\da-f-]{36}$/i),
    }),
  );
  expect(confirm).toHaveBeenCalledTimes(1);
});
it("records the real send of a queued outreach event at the version the queue produced", async () => {
  const event = "00000000-0000-4000-8000-0000000000e1";
  const calls = vi
    .spyOn(api, "operation")
    .mockImplementation(
      async (name) => ({ id: event, version: name === "outreach.queue" ? 2 : 3 }) as never,
    );
  vi.spyOn(window, "confirm").mockReturnValue(true);
  function Card({ record }: { record: RecordData }) {
    return <OutreachCard record={record} name="Ana" restricted={useRestricted()} />;
  }
  const view = provider(<Card record={{ id: event, version: 1, state: "draft", body: "Hola" }} />);
  fireEvent.change(screen.getByLabelText("Recordatorio para preparar el envío"), {
    target: { value: "2026-10-09T09:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Poner en cola (sin enviar)" }));
  await waitFor(() =>
    expect(calls).toHaveBeenCalledWith(
      "outreach.queue",
      expect.objectContaining({ expected_version: 1 }),
    ),
  );
  view.rerender(
    <QueryClientProvider client={view.client}>
      <Card record={{ id: event, version: 2, state: "queued", body: "Hola" }} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Fecha del envío real"), {
    target: { value: "2026-10-09T10:00" },
  });
  fireEvent.change(screen.getByLabelText("Referencia de la entrega manual"), {
    target: { value: "Hilo confirmado" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Registrar envío real" }));
  await waitFor(() =>
    expect(calls).toHaveBeenCalledWith(
      "outreach.mark_sent",
      expect.objectContaining({ expected_version: 2 }),
    ),
  );
  await waitFor(() => expect(recoverySnapshot()[`outreach-event:${event}`]).toBeUndefined());
});
it("reapplies only the owner's automation changes over a policy changed elsewhere", () => {
  const base = { enabled: true, exa_daily_usd: 5, digest_email: true, sources: ["exa"] };
  const draft = { ...base, exa_daily_usd: 2 };
  const current = { ...base, enabled: false, digest_email: false };
  const next = rebaseDraft(draft as Policy, base as Policy, current as Policy);
  expect(next.changed).toEqual(["exa_daily_usd"]);
  expect(next.policy).toEqual({ ...current, exa_daily_usd: 2 });
});
it("labels queued automation work with a chosen profile or an explicit unknown", () => {
  const work = (checkpoint: Record<string, unknown>) =>
    ({ profile_id: "ai-MX", checkpoint }) as unknown as Work;
  expect(workProfile(work({ needs_profile: true }))).toBe("Perfil por determinar");
  expect(workProfile(work({ needs_profile: true, phase: "profile-review" }))).toBe(
    "Perfil requiere revisión",
  );
  expect(workProfile(work({ needs_profile: true, selection: { profile_id: "frontend-PE" } }))).toBe(
    "Frontend · Perú",
  );
  expect(workProfile(work({}))).toBe("Inteligencia artificial · México");
});
it("exports retained form drafts and intents along with queued edits", async () => {
  await retainRecovery("form:contacts:new:contacts.upsert:Agregar contacto", {
    values: { name: "Ana" },
  });
  const blobs: Blob[] = [];
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = (blob: Blob) => (blobs.push(blob), "blob:export");
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  exportDrafts([]);
  // jsdom's Blob lacks text(); FileReader reads it.
  const saved = JSON.parse(
    await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blobs[0]!);
    }),
  );
  expect(saved.recovery["form:contacts:new:contacts.upsert:Agregar contacto"]).toEqual({
    values: { name: "Ana" },
  });
  vi.unstubAllGlobals();
});
it("does not call list classifications legacy just because the list omits criteria", () => {
  const job = {
    id,
    version: 1,
    triage: {
      state: "completed",
      updated_at: "2026-10-07T12:00:00Z",
      stale: false,
      jev: { status: "completed", judgments: {} },
    },
  };
  const list = render(<JevClassification job={job} fromList />);
  expect(screen.getByText("Los criterios están en el detalle de la vacante.")).toBeTruthy();
  expect(screen.queryByText(/Requiere una nueva clasificación/)).toBeNull();
  list.unmount();
  render(<JevClassification job={job} expanded />);
  expect(screen.getByText(/Requiere una nueva clasificación/)).toBeTruthy();
});
it("asks for an ISO currency before saving a salary", async () => {
  const calls = vi.spyOn(api, "operation").mockResolvedValue({ id, version: 2 });
  provider(
    <Editor
      entity="jobs"
      operation="jobs.upsert"
      record={{ id, version: 1, title: "Vacante" }}
      title="Editar salario"
      fields={[
        { name: "salary_min", label: "Salario mínimo", type: "number" },
        { name: "currency", label: "Moneda ISO (MXN, USD, EUR)" },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Editar salario" }));
  fireEvent.change(screen.getByLabelText("Salario mínimo"), { target: { value: "5000" } });
  fireEvent.submit(screen.getByRole("form", { name: "Editar salario" }));
  await screen.findByText(/moneda ISO de tres letras/);
  expect(calls).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Moneda ISO (MXN, USD, EUR)"), {
    target: { value: "usd" },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Editar salario" }));
  await waitFor(() => expect(calls).toHaveBeenCalledTimes(1));
  expect(calls.mock.calls[0]?.[1]).toMatchObject({ salary_min: 5000, currency: "USD" });
});
it("explains an unknown interview time zone in Spanish on the zone field", async () => {
  provider(
    <Editor
      entity="interviews"
      operation="interviews.upsert"
      title="Programar con zona"
      fields={[
        { name: "scheduled_at", label: "Fecha y hora local", type: "datetime-local" },
        { name: "timezone", label: "Zona horaria IANA", required: true },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Programar con zona" }));
  fireEvent.change(screen.getByLabelText("Fecha y hora local"), {
    target: { value: "2026-10-09T10:00" },
  });
  fireEvent.change(screen.getByLabelText("Zona horaria IANA"), {
    target: { value: "Mexico City" },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Programar con zona" }));
  await screen.findByText(/Zona horaria IANA inválida/);
  expect(screen.getByLabelText("Zona horaria IANA").getAttribute("aria-invalid")).toBe("true");
});
it("orders the interview agenda by upcoming date before past and unscheduled interviews", () => {
  const row = (key: string, state: string, scheduled_at?: string) =>
    ({ id: key, version: 1, state, scheduled_at }) as never;
  const order = [
    row("old", "completed", "2026-09-01T10:00:00Z"),
    row("later", "planned", "2026-10-20T10:00:00Z"),
    row("unscheduled", "planned"),
    row("soon", "planned", "2026-10-08T10:00:00Z"),
    row("recent", "completed", "2026-10-01T10:00:00Z"),
  ]
    .sort(agendaOrder)
    .map((r: { id: string }) => r.id);
  expect(order).toEqual(["soon", "later", "unscheduled", "recent", "old"]);
});
it("does not offer records created offline as references before they sync", () => {
  expect(
    options([
      { id, version: 1, name: "Sincronizada" },
      { id: "local-only", version: 0, name: "Pendiente", pending_local: true },
    ]),
  ).toEqual([{ value: id, label: "Sincronizada" }]);
});
it("replays an edit that only survived in recovery, and never dispatches one it could not retain", async () => {
  const key = "44444444-4444-4444-8444-444444444444";
  const edit = {
    operation: "contacts.upsert",
    entity_id: id,
    id: key,
    order: 1,
    input: { id, expected_version: 3, idempotency_key: key, name: "Recuperado" },
  };
  await retainRecovery(`edit:${key}`, edit);
  const rpc = vi.spyOn(api, "operation").mockResolvedValue({ id, version: 4 });
  const view = render(
    <CrmProvider logout={async () => {}}>
      <p>Listo</p>
    </CrmProvider>,
  );
  await screen.findByText("Listo");
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("contacts.upsert", edit.input));
  await waitFor(() => expect(recoverySnapshot()[`edit:${key}`]).toBeUndefined());
  view.unmount();
  rpc.mockClear();
  vi.spyOn(storage, "stored").mockRejectedValue(new Error("IndexedDB bloqueado"));
  let accepted: boolean | undefined;
  function Save() {
    const save = useEdit(id);
    return (
      <button
        onClick={async () => {
          accepted = await save("contacts.upsert", { id, expected_version: 4, name: "Nuevo" });
        }}
      >
        Guardar contacto
      </button>
    );
  }
  provider(<Save />);
  fireEvent.click(screen.getByText("Guardar contacto"));
  await waitFor(() => expect(accepted).toBe(false));
  expect(rpc).not.toHaveBeenCalled();
});
it("expires notices after visible unpaused time and never times out recovery errors", () => {
  vi.useFakeTimers();
  const close = vi.fn();
  const view = render(<NoticeBanner message="Cambio guardado." kind="success" close={close} />);
  act(() => vi.advanceTimersByTime(2000));
  fireEvent.mouseEnter(screen.getByRole("status"));
  act(() => vi.advanceTimersByTime(10000));
  expect(close).not.toHaveBeenCalled();
  fireEvent.mouseLeave(screen.getByRole("status"));
  act(() => vi.advanceTimersByTime(3999));
  expect(close).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(close).toHaveBeenCalledOnce();
  view.rerender(<NoticeBanner key="error" message="Resultado sin confirmar" close={close} />);
  act(() => vi.advanceTimersByTime(20000));
  expect(close).toHaveBeenCalledOnce();
});
it("uses one bounded dashboard request and preserves unknown legacy history", async () => {
  const rpc = vi.spyOn(api, "operation").mockResolvedValue({
    workspace: {
      followup_count: 7,
      featured_jobs: [
        { id, version: 1, title: "Vacante", stage: "radar", updated_at: "2026-10-04T09:00:00Z" },
      ],
      upcoming_interviews: [
        { id: "i1", version: 1, job_id: id, scheduled_at: "2026-10-09T16:00:00Z", timezone: "UTC" },
      ],
    },
    counts_by_stage: { applied: 3 },
  });
  const navigate = vi.fn();
  const view = provider(<Dashboard navigate={navigate} />);
  await screen.findByText("7 seguimientos por revisar");
  const metrics = [...view.container.querySelectorAll(".metrics strong")].map((n) => n.textContent);
  expect(metrics).toEqual(["0", "3", "0", "0"]);
  const vacancy = screen.getByRole("link", { name: "Vacante" });
  expect(vacancy.getAttribute("href")).toBe(`/?screen=pipeline&job=${id}&section=interviews`);
  fireEvent.click(vacancy);
  expect(navigate).toHaveBeenCalledWith("pipeline", "interviews", id);
  expect(screen.getByText(/Detalle del cambio no disponible/)).toBeTruthy();
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(["dashboard.summary"]);
  expect(savedNotice({ erased: true })).toContain("no se recrearon");
});
it("shows one filtered pending creation then removes its overlay after acknowledgment", async () => {
  const client = makeClient();
  vi.spyOn(api, "operation").mockResolvedValue({
    items: [],
    has_more: false,
    next_cursor: null,
  } as never);
  const mutation = client.getMutationCache().build(client, { mutationKey: ["ordinary-edit"] }, {
    status: "pending",
    variables: {
      operation: "contacts.upsert",
      entity_id: id,
      input: { name: "María", status: "connected" },
      id,
      order: 1,
    },
    isPaused: true,
  } as never);
  function Rows() {
    const query = useRecords("contacts.search", { status: "connected" });
    return (
      <>
        {query.records.map((r) => (
          <p key={r.id}>
            {String(r.name)} {r.pending_local ? "pendiente" : ""}
          </p>
        ))}
      </>
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Rows />
    </QueryClientProvider>,
  );
  await screen.findByText("María pendiente");
  expect(screen.getAllByText("María pendiente")).toHaveLength(1);
  act(() => client.getMutationCache().remove(mutation));
  await waitFor(() => expect(screen.queryByText("María pendiente")).toBeNull());
});
it("requires reviewed erasure scope and clears it after an exact lost-ACK replay", async () => {
  let erased = false;
  const rpc = vi.spyOn(api, "operation").mockImplementation(async (name) => {
    if (name === "contacts.erase" && !erased) {
      erased = true;
      throw new Error("ACK de borrado perdido");
    }
    return name === "contacts.preview_erasure"
      ? ({
          contact_id: id,
          expected_version: 3,
          inventory_hash: "a".repeat(64),
          inventory: {
            contact: 1,
            outreach: 2,
            interviews: 1,
            audits: 0,
            receipts: 1,
            import_tasks: 0,
            legacy_links: 0,
            embeddings: 0,
          },
          remaining_copies: ["Legacy original, expiry unknown"],
          limitations: ["Unrelated text stays"],
        } as never)
      : ({ contact_id: id, erased: true, version: 4 } as never);
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  provider(<ContactErasure id={id} />);
  expect(screen.queryByText("Confirmar borrado permanente")).toBeNull();
  fireEvent.click(screen.getByText("Revisar alcance del borrado"));
  await screen.findByText("Legacy original, expiry unknown");
  expect((screen.getByText("Confirmar borrado permanente") as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByLabelText(/He revisado/));
  fireEvent.click(screen.getByText("Confirmar borrado permanente"));
  await waitFor(() =>
    expect(rpc.mock.calls.some(([name]) => name === "contacts.erase")).toBe(true),
  );
  expect(rpc.mock.calls.find(([name]) => name === "contacts.erase")?.[1]).toMatchObject({
    id,
    expected_version: 3,
    inventory_hash: "a".repeat(64),
    owner_reviewed: true,
  });
  await screen.findByText("ACK de borrado perdido");
  const original = rpc.mock.calls.find(([name]) => name === "contacts.erase")?.[1];
  fireEvent.click(screen.getByText("Reintentar borrado original"));
  await waitFor(() => expect(screen.queryByText("Confirmar borrado permanente")).toBeNull());
  expect(
    rpc.mock.calls.filter(([name]) => name === "contacts.erase").map(([, input]) => input),
  ).toEqual([original, original]);
  expect(screen.queryByLabelText(/He revisado/)).toBeNull();
});

it("excludes archived erasure tombstones from actionable followups", () => {
  expect(
    followups([{ id, version: 2, status: "connected", archived_at: "2026-10-04T00:00:00Z" }], []),
  ).toEqual([]);
});

it("pauses notices while hidden and gives replacements a complete new visible duration", () => {
  vi.useFakeTimers();
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  const old = vi.fn(),
    replacement = vi.fn();
  const view = render(
    <NoticeBanner key="old" message="Cambio guardado." kind="success" close={old} />,
  );
  act(() => vi.advanceTimersByTime(2500));
  visibility = "hidden";
  fireEvent(document, new Event("visibilitychange"));
  act(() => vi.advanceTimersByTime(12000));
  expect(old).not.toHaveBeenCalled();
  visibility = "visible";
  fireEvent(document, new Event("visibilitychange"));
  act(() => vi.advanceTimersByTime(1000));
  view.rerender(
    <NoticeBanner key="new" message="Cambio guardado." kind="success" close={replacement} />,
  );
  act(() => vi.advanceTimersByTime(5999));
  expect(replacement).not.toHaveBeenCalled();
  expect(old).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(replacement).toHaveBeenCalledOnce();
});

it("retains confirmed conflict metadata and permits explicit recovery without clearing ambiguity", async () => {
  const rpc = vi
    .spyOn(api, "operation")
    .mockRejectedValueOnce(new api.OperationError("CONFLICT", "stale", undefined, undefined, 5));
  function Controls() {
    const write = useExactWrite("conflict-test");
    return (
      <>
        <button onClick={() => void write.write("contacts.archive", { id, expected_version: 4 })}>
          Enviar conflicto
        </button>
        <button disabled={!write.confirmedRejected} onClick={() => void write.discardRejected()}>
          Descartar rechazo
        </button>
        {write.intent && <p>Solicitud retenida</p>}
        {write.rejection && <p>Versión {write.rejection.current_version}</p>}
      </>
    );
  }
  provider(<Controls />);
  fireEvent.click(screen.getByText("Enviar conflicto"));
  await screen.findByText("Versión 5");
  expect(recoverySnapshot()["intent:conflict-test"]).toMatchObject({
    input: { expected_version: 4 },
  });
  fireEvent.click(screen.getByText("Descartar rechazo"));
  await waitFor(() => expect(screen.queryByText("Solicitud retenida")).toBeNull());
  rpc.mockRejectedValueOnce(new api.OperationError("TEMPORARY_FAILURE", "unknown"));
  fireEvent.click(screen.getByText("Enviar conflicto"));
  await screen.findByText("Solicitud retenida");
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  expect((screen.getByText("Descartar rechazo") as HTMLButtonElement).disabled).toBe(true);
});

it("preserves concurrent form changes while swapping a rejected request identity", async () => {
  const { replaceRecovery } = await import("../src/shared/state/recovery");
  await retainRecovery("edit:old", { input: { notes: "old" } });
  const original = storage.stored;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let once = true;
  vi.spyOn(storage, "stored").mockImplementation(async (key, action, value) => {
    if (once && action === "put") {
      once = false;
      started();
      await blocked;
    }
    return original(key, action, value);
  });
  const swap = replaceRecovery("edit:old", "edit:new", { input: { notes: "reapplied" } });
  await entered;
  const concurrent = retainRecovery("form:other", { notes: "independent draft" });
  release();
  await Promise.all([swap, concurrent]);
  expect(recoverySnapshot()["edit:old"]).toBeUndefined();
  expect(recoverySnapshot()["edit:new"]).toMatchObject({ input: { notes: "reapplied" } });
  expect(recoverySnapshot()["form:other"]).toEqual({ notes: "independent draft" });
});

it("blocks restoration failure and offers retry/export before mounting editable content", async () => {
  const { CrmProvider } = await import("../src/shared/state/crm");
  const originalPersister = storage.persister;
  vi.spyOn(storage, "persister").mockImplementation((owner) => {
    const base = originalPersister(owner);
    return {
      ...base,
      restoreClient: vi
        .fn()
        .mockRejectedValueOnce(new Error("restore blocked"))
        .mockImplementation(() => base.restoreClient()),
    };
  });
  render(
    <CrmProvider logout={async () => {}}>
      <p>Contenido autorizado</p>
    </CrmProvider>,
  );
  await screen.findByText(/No se pudo restaurar la caché/);
  expect(screen.queryByText("Contenido autorizado")).toBeNull();
  expect(screen.getByText("Exportar recuperación")).toBeTruthy();
  vi.restoreAllMocks();
  fireEvent.click(screen.getByText("Reintentar restauración"));
  await screen.findByText("Contenido autorizado");
});

it("can persist after cache cleanup while explicit logout permanently deactivates its writer", async () => {
  const owner = "cleanup-owner";
  const store = storage.persister(owner);
  const snapshot = {
    timestamp: Date.now(),
    buster: "1",
    clientState: { mutations: [], queries: [] },
  };
  await store.persistClient(snapshot);
  await store.removeClient();
  await store.persistClient(snapshot);
  expect(await store.restoreClient()).toEqual(snapshot);
  await store.deactivate();
  await store.persistClient(snapshot);
  expect(await store.restoreClient()).toBeUndefined();
});

it("does not resurrect incompatible participants after a vacancy change and navigation", async () => {
  const second = "00000000-0000-4000-8000-000000000002";
  const fields = [
    {
      name: "job_id",
      label: "Vacante",
      required: true,
      options: [
        { value: id, label: "Original" },
        { value: second, label: "Nueva" },
      ],
    },
    {
      name: "interviewer_ids",
      label: "Participantes",
      multiple: true,
      dependsOn: "job_id",
      options: [
        { value: id, label: "María", group: id },
        { value: second, label: "Juan", group: second },
      ],
    },
  ];
  const record = { id, version: 4, job_id: id, interviewer_ids: [id] };
  const first = provider(
    <Editor
      entity="interviews"
      operation="interviews.upsert"
      record={record}
      title="Cambiar vacante"
      fields={fields}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Cambiar vacante" }));
  fireEvent.change(screen.getByLabelText("Vacante"), { target: { value: second } });
  await waitFor(() =>
    expect(
      recoverySnapshot()[`form:interviews:${id}:interviews.upsert:Cambiar vacante`],
    ).toMatchObject({ values: { job_id: second, interviewer_ids: [] } }),
  );
  first.unmount();
  provider(
    <Editor
      entity="interviews"
      operation="interviews.upsert"
      record={record}
      title="Cambiar vacante"
      fields={fields}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Cambiar vacante" }));
  expect((screen.getByLabelText("Vacante") as HTMLSelectElement).value).toBe(second);
  const participants = screen.getByLabelText("Participantes") as HTMLSelectElement;
  expect(participants.selectedOptions).toHaveLength(0);
  expect(participants.options[0]?.text).toBe("Juan");
});
