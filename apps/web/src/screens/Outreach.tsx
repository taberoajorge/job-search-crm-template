import { useRetained } from "../shared/state/recovery";
import { useEffect, useState } from "react";
import { useEdit, useLookupRecords, useRecords, useRestricted } from "../shared/state/crm";
import {
  followups,
  outreachAgenda,
  outreachCounts,
  projectOutreach,
  text,
  type OutreachScope,
} from "../shared/state/model";
import {
  agent,
  Badge,
  ContactProfile,
  Copy,
  Editor,
  enumOptions,
  options,
  Preview,
  Status,
} from "../shared/ui/controls";
import type { RecordData } from "../shared/api/client";
import {
  FilterDialog,
  CollectionPager,
  LookupStatus,
  useCollectionPage,
} from "../shared/ui/collections";
import { ResourceTable } from "../shared/ui/resource-table";
const sections = [
  ["drafts", "Borradores de contactos", "Borradores"],
  ["followups", "Seguimientos", "Seguimientos"],
  ["programados", "Recordatorios y timeline", "Programados"],
  ["events", "Conversaciones registradas", "Historial"],
] as const;
function selectedSection() {
  const value = new URLSearchParams(location.search).get("section") || "drafts";
  return value === "events"
    ? "programados"
    : sections.some(([id]) => id === value)
      ? value
      : "drafts";
}
function selectedView() {
  const params = new URLSearchParams(location.search);
  if (params.get("section") === "events") return "timeline" as const;
  return params.get("view") === "timeline" ? ("timeline" as const) : ("agenda" as const);
}
export function Outreach() {
  const response = useRetained<Record<string, string>>("outreach-response");
  const [section, setSection] = useState(selectedSection);
  const [view, setView] = useState(selectedView);
  const [state, setState] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [companyScope, setCompanyScope] = useState<OutreachScope>("either");
  const events = useRecords(
    "outreach.list",
    section === "programados" ? {} : state ? { state } : {},
  );
  const contacts = useLookupRecords("contacts.search");
  const jobs = useLookupRecords("jobs.list");
  const companies = useLookupRecords("companies.list");
  const resumes = useLookupRecords("resumes.list");
  const drafts = contacts.records.filter(
    (c) => text(c.draft_note).trim() || text(c.draft_message).trim(),
  );
  const due = followups(contacts.records, jobs.records);
  const projected = projectOutreach(
    events.records,
    contacts.records,
    jobs.records,
    companies.records,
    companyId,
    companyScope,
  );
  const scheduleRecords = view === "agenda" ? outreachAgenda(projected) : projected;
  const page = useCollectionPage(
    section === "events"
      ? events
      : section === "programados"
        ? { ...events, records: scheduleRecords }
        : { ...contacts, records: section === "followups" ? due : drafts },
    `${section}:${state}:${view}:${companyId}:${companyScope}`,
  );
  const restricted = useRestricted();
  const choose = (value: string, nextView: "agenda" | "timeline" = view) => {
    const nextSection = value;
    setSection(nextSection);
    setView(nextView);
    const url = new URL(location.href);
    url.searchParams.set("section", nextSection);
    if (nextSection === "programados") url.searchParams.set("view", nextView);
    else url.searchParams.delete("view");
    history.pushState({}, "", url);
  };
  useEffect(() => {
    const pop = () => {
      setSection(selectedSection());
      setView(selectedView());
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  return (
    <>
      <div className="page-heading">
        <h1>Mensajes</h1>
        <div className="actions">
          <Editor
            entity="outreach"
            operation="outreach.draft"
            title="Nuevo borrador"
            onSubmitted={() => choose("events")}
            fields={[
              {
                name: "contact_id",
                label: "Contacto (elige contacto o vacante)",
                options: options(contacts.records),
              },
              { name: "job_id", label: "Vacante", options: options(jobs.records, "title") },
              {
                name: "channel",
                label: "Canal",
                required: true,
                options: enumOptions(["manual", "email", "linkedin"]),
              },
              {
                name: "kind",
                label: "Tipo",
                required: true,
                options: enumOptions(["invitation", "message", "followup", "application"]),
              },
              {
                name: "resume_id",
                label: "CV adjunto",
                options: options(resumes.records, "label"),
              },
              { name: "body", label: "Mensaje", type: "textarea", required: true },
            ]}
            initial={{ channel: "linkedin", kind: "message" }}
          />
          <Preview title="Registrar una respuesta recibida" trigger="Registrar respuesta">
            <form
              onChange={(event) =>
                response.set(
                  Object.fromEntries(
                    [...new FormData(event.currentTarget)].map(([key, value]) => [
                      key,
                      String(value),
                    ]),
                  ),
                )
              }
              onSubmit={(event) => {
                event.preventDefault();
                const node = event.currentTarget;
                const form = new FormData(node);
                void restricted(
                  "outreach.record_response",
                  {
                    contact_id: form.get("contact_id"),
                    body: form.get("body"),
                    occurred_at: new Date(String(form.get("occurred_at"))).toISOString(),
                  },
                  "¿Registrar esta respuesta real del contacto?",
                ).then((result) => {
                  if (result) {
                    response.set(null);
                    node.closest("dialog")?.close();
                    choose("events");
                  }
                });
              }}
            >
              <label>
                Contacto
                <select required name="contact_id" defaultValue={response.value?.contact_id ?? ""}>
                  <option value="">Selecciona…</option>
                  {response.value?.contact_id &&
                    !contacts.records.some(
                      (contact) => contact.id === response.value?.contact_id,
                    ) && (
                      <option value={response.value.contact_id}>
                        Contacto registrado sin datos disponibles
                      </option>
                    )}
                  {options(contacts.records).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Respuesta
                <textarea name="body" required defaultValue={response.value?.body ?? ""} />
              </label>
              <label>
                Fecha real de la respuesta
                <input
                  type="datetime-local"
                  name="occurred_at"
                  required
                  defaultValue={response.value?.occurred_at ?? ""}
                />
              </label>
              {response.error && <p role="alert">{response.error}</p>}
              <div className="actions">
                <button disabled={!navigator.onLine}>Registrar respuesta</button>
                <button
                  type="button"
                  onClick={(event) => {
                    // Explicit Cancel discards; outside dismissal keeps the draft.
                    const form = event.currentTarget.form;
                    form
                      ?.querySelectorAll<HTMLInputElement>("input, textarea, select")
                      .forEach((field) => (field.value = ""));
                    response.set(null);
                    form?.closest("dialog")?.close();
                  }}
                >
                  Cancelar
                </button>
              </div>
            </form>
          </Preview>
        </div>
      </div>
      <nav className="actions message-sections" aria-label="Secciones de mensajes">
        {sections.map(([id, label, short]) => (
          // The visible text is the accessible name (label in name); the long label is a tooltip.
          <button
            key={id}
            title={label}
            aria-current={section === id ? "page" : undefined}
            onClick={() => choose(id)}
          >
            {short}
          </button>
        ))}
      </nav>
      {section === "drafts" && (
        <p>
          Notas de invitación y mensajes guardados en tus contactos. Una cola pendiente no significa
          que ya se enviaron.
        </p>
      )}
      {section === "followups" && (
        <p>
          Por escribir o retomar: contactos sin escribir vinculados a aplicaciones, conexiones
          pendientes, invitaciones de más de siete días y mensajes de más de cinco días sin
          respuesta.
        </p>
      )}
      {section === "programados" && (
        <>
          <p>
            Estos registros son recordatorios humanos para preparar o revisar un contacto. Programar
            una fecha no envía ningún mensaje.
          </p>
          <div className="collection-toolbar">
            <div className="actions" aria-label="Vista de programados">
              {(["agenda", "timeline"] as const).map((candidate) => (
                <button
                  key={candidate}
                  aria-current={view === candidate ? "page" : undefined}
                  onClick={() => choose("programados", candidate)}
                >
                  {candidate === "agenda" ? "Agenda" : "Timeline"}
                </button>
              ))}
            </div>
            <FilterDialog
              count={(companyId ? 1 : 0) + (companyScope !== "either" ? 1 : 0)}
              onClear={() => {
                setCompanyId("");
                setCompanyScope("either");
              }}
              onApply={(data) => {
                setCompanyId(text(data.get("company_id")));
                setCompanyScope((text(data.get("company_scope")) || "either") as OutreachScope);
              }}
            >
              <label>
                Empresa
                <select name="company_id" defaultValue={companyId}>
                  <option value="">Todas</option>
                  {companies.records.map((company) => (
                    <option key={company.id} value={company.id}>
                      {text(company.name)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Relación de empresa
                <select name="company_scope" defaultValue={companyScope}>
                  <option value="either">Cualquiera de las dos</option>
                  <option value="contact">Empresa del contacto</option>
                  <option value="vacancy">Empresa de la vacante</option>
                </select>
              </label>
            </FilterDialog>
          </div>
        </>
      )}
      {section === "events" && (
        <div className="collection-toolbar">
          <FilterDialog
            count={state ? 1 : 0}
            onClear={() => setState("")}
            onApply={(data) => setState(text(data.get("state")))}
          >
            <label>
              Estado del mensaje
              <select name="state" defaultValue={state}>
                <option value="">Todos</option>
                {enumOptions(["draft", "queued", "sent", "failed", "responded", "cancelled"]).map(
                  (option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ),
                )}
              </select>
            </label>
          </FilterDialog>
        </div>
      )}
      <LookupStatus query={contacts} label="contactos" />
      <LookupStatus query={jobs} label="vacantes" />
      <LookupStatus query={companies} label="empresas" />
      <LookupStatus query={resumes} label="currículums" />
      {section === "programados" ? (
        <ScheduleView
          page={page}
          view={view}
          restricted={restricted}
          contacts={contacts.records}
          jobs={jobs.records}
          companies={companies.records}
          complete={
            !events.hasNextPage &&
            !contacts.hasNextPage &&
            !jobs.hasNextPage &&
            !companies.hasNextPage &&
            !events.isPending &&
            !contacts.isPending &&
            !jobs.isPending &&
            !companies.isPending &&
            !events.isError &&
            !contacts.isError &&
            !jobs.isError &&
            !companies.isError
          }
          query={events}
        />
      ) : section === "events" ? (
        <>
          <ResourceTable
            entity="outreach"
            label="Conversaciones registradas"
            rows={page.records}
            columns={[
              {
                key: "name",
                label: "Contacto o vacante",
                render: (event) => (
                  <strong>
                    {text(contacts.records.find((c) => c.id === event.contact_id)?.name) ||
                      text(jobs.records.find((j) => j.id === event.job_id)?.title) ||
                      "Conversación"}
                  </strong>
                ),
              },
              { key: "state", label: "Estado", render: (event) => <Badge value={event.state} /> },
            ]}
            actions={(event) => (
              <Preview title="Mensaje registrado" entity="outreach" id={event.id}>
                <OutreachCard
                  record={event}
                  name={text(contacts.records.find((c) => c.id === event.contact_id)?.name)}
                  restricted={restricted}
                />
              </Preview>
            )}
          />
          <Status query={events} empty={false} />
          {!events.isPending && !events.isError && !events.isFetching && !page.loaded && (
            <p>
              No hay conversaciones registradas. Los textos guardados en tus contactos se encuentran
              en Borradores de contactos.
            </p>
          )}
        </>
      ) : (
        <>
          <ResourceTable
            entity="contacts"
            label={
              section === "followups" ? "Seguimientos de contactos" : "Borradores de contactos"
            }
            rows={page.records}
            columns={[
              {
                key: "name",
                label: "Contacto",
                render: (contact) => (
                  <div className="resource-identity">
                    <strong>{text(contact.name)}</strong>
                    <small>{text(contact.role)}</small>
                  </div>
                ),
              },
              {
                key: "status",
                label: "Estado",
                render: (contact) => <Badge value={contact.status} />,
              },
            ]}
            actions={(contact) => <DraftPreview contact={contact} />}
          />
          {!contacts.isPending &&
            !contacts.isError &&
            !contacts.hasNextPage &&
            !contacts.isFetching &&
            !page.loaded && (
              <p>
                {section === "followups"
                  ? "No hay seguimientos pendientes."
                  : "No hay borradores guardados en los contactos."}
              </p>
            )}
        </>
      )}
      <CollectionPager
        page={page}
        label={
          section === "followups"
            ? "seguimientos"
            : section === "drafts"
              ? "borradores"
              : "mensajes"
        }
      />
    </>
  );
}
function ScheduleView({
  page,
  view,
  restricted,
  contacts,
  jobs,
  companies,
  complete,
  query,
}: {
  page: ReturnType<typeof useCollectionPage>;
  view: "agenda" | "timeline";
  restricted: ReturnType<typeof useRestricted>;
  contacts: RecordData[];
  jobs: RecordData[];
  companies: RecordData[];
  complete: boolean;
  query: ReturnType<typeof useRecords>;
}) {
  const rows = page.records as ReturnType<typeof projectOutreach>;
  const counts = outreachCounts(rows);
  return (
    <>
      <p role="status">
        {counts.people} personas · {counts.events} {view === "agenda" ? "recordatorios" : "eventos"}
        {!complete && " · conteo parcial: aún faltan datos"}
      </p>
      <ResourceTable
        entity="outreach"
        label={view === "agenda" ? "agenda de recordatorios" : "timeline de outreach"}
        rows={rows}
        columns={[
          {
            key: "time",
            label: view === "agenda" ? "Fecha del recordatorio" : "Fecha",
            render: (event) => {
              const row = event as ReturnType<typeof projectOutreach>[number];
              return (
                <div className="resource-identity">
                  <small>
                    {view === "agenda" && row.scheduled_for
                      ? new Date(String(row.scheduled_for)).toLocaleDateString("es", {
                          weekday: "long",
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                        })
                      : view === "agenda"
                        ? "Sin fecha programada"
                        : undefined}
                  </small>
                  <strong>
                    {row.timeLabel}{" "}
                    {row.time ? (
                      <time dateTime={row.time}>{new Date(row.time).toLocaleString("es")}</time>
                    ) : (
                      "Sin fecha programada"
                    )}
                  </strong>
                  {view === "agenda" && !row.scheduled_for && <small>Sin fecha programada</small>}
                  {row.overdue && <small>Vencido</small>}
                </div>
              );
            },
          },
          {
            key: "context",
            label: "Persona / vacante",
            render: (event) => {
              const row = event as ReturnType<typeof projectOutreach>[number];
              const contact =
                text(row.contact?.name) || (row.contact_id ? "Contacto no disponible" : "");
              const job = text(row.job?.title) || (row.job_id ? "Vacante no disponible" : "");
              const companyNames = [row.contactCompany?.name, row.jobCompany?.name]
                .map(text)
                .filter(Boolean)
                .filter((name, index, all) => all.indexOf(name) === index);
              return (
                <div className="resource-identity">
                  <strong>{contact || job || "Conversación"}</strong>
                  {job && contact && <small>{job}</small>}
                  <small>
                    {companyNames.length
                      ? companyNames.join(" · ")
                      : row.relationshipUnavailable
                        ? "Empresa no disponible"
                        : "Sin empresa registrada"}
                  </small>
                </div>
              );
            },
          },
          { key: "state", label: "Estado", render: (event) => <Badge value={event.state} /> },
        ]}
        actions={(event) => {
          const row = event as ReturnType<typeof projectOutreach>[number];
          return (
            <Preview title="Detalle del outreach programado" entity="outreach" id={row.id}>
              <OutreachCard
                record={row}
                name={text(row.contact?.name) || text(row.job?.title)}
                restricted={restricted}
              />
              <p>
                {row.timeLabel}:{" "}
                {row.time ? new Date(row.time).toLocaleString("es") : "Sin fecha registrada"} ·{" "}
                {text(row.channel)} · {text(row.kind)}
              </p>
              {[row.contactCompany?.name, row.jobCompany?.name].filter(Boolean).length > 0 && (
                <p>
                  Empresas registradas:{" "}
                  {[row.contactCompany?.name, row.jobCompany?.name].filter(Boolean).join(" · ")}
                </p>
              )}
            </Preview>
          );
        }}
      />
      <Status query={query} empty={false} />
      {!query.isPending && !query.isError && !query.isFetching && !page.loaded && (
        <p>
          {view === "agenda"
            ? "No hay recordatorios programados."
            : "No hay eventos de outreach registrados."}
        </p>
      )}
      {!complete && (
        <p role="status">
          Hay relaciones o páginas pendientes; se muestran los registros disponibles.
        </p>
      )}
      <CollectionPager page={page} label={view === "agenda" ? "recordatorios" : "eventos"} />
      {contacts.length + jobs.length + companies.length === 0 && (
        <p>Las relaciones de persona, vacante y empresa aún no están disponibles.</p>
      )}
    </>
  );
}
function DraftPreview({ contact }: { contact: RecordData }) {
  return (
    <Preview title={`Borradores de ${text(contact.name)}`} entity="contacts" id={contact.id}>
      <ContactProfile record={contact} />
      {Boolean(contact.queued_at) && (
        <section aria-label="Registro de cola">
          <h3>Registro de cola</h3>
          <p>Fecha registrada: {new Date(text(contact.queued_at)).toLocaleString("es")}</p>
          <p>Este registro no confirma que se haya enviado una invitación o un mensaje.</p>
        </section>
      )}
      {text(contact.draft_note) && (
        <section>
          <h3>Nota de invitación</h3>
          <p className="message-body">{text(contact.draft_note)}</p>
          <Copy value={text(contact.draft_note)} id={contact.id} />
        </section>
      )}
      {text(contact.draft_message) && (
        <section>
          <h3>Mensaje</h3>
          <p className="message-body">{text(contact.draft_message)}</p>
          <Copy value={text(contact.draft_message)} id={contact.id} />
        </section>
      )}
      {!text(contact.draft_note) && !text(contact.draft_message) && (
        <p>Aún no hay texto preparado para este contacto.</p>
      )}
      <Editor
        entity="contacts"
        operation="contacts.upsert"
        record={contact}
        title="Editar borradores"
        fields={[
          {
            name: "draft_note",
            label: "Nota de invitación (máximo 300 caracteres)",
            type: "textarea",
            maxLength: 300,
          },
          { name: "draft_message", label: "Borrador de mensaje", type: "textarea" },
        ]}
      />
    </Preview>
  );
}
export function OutreachCard({
  record: e,
  name,
  restricted,
}: {
  record: RecordData;
  name: string;
  restricted: ReturnType<typeof useRestricted>;
}) {
  const retained = useRetained<{
    reminderDate: string;
    sentDate: string;
    reference: string;
    version: number;
  }>(`outreach-event:${e.id}`);
  const draft = retained.value ?? {
    reminderDate: "",
    sentDate: "",
    reference: "",
    version: e.version,
  };
  const { reminderDate, sentDate, reference } = draft;
  const setReminderDate = (value: string) => retained.set({ ...draft, reminderDate: value });
  const setSentDate = (value: string) => retained.set({ ...draft, sentDate: value });
  const setReference = (value: string) => retained.set({ ...draft, reference: value });
  const edit = useEdit(e.id);
  return (
    <article className="card" {...agent("outreach", e.id, "card")}>
      <Badge value={e.state} />
      {retained.error && <p role="alert">{retained.error}</p>}
      <h2>{name || "Conversación"}</h2>
      <p className="message-body">{text(e.body)}</p>
      <p>
        {text(e.channel)} · {text(e.scheduled_for)}
      </p>
      <Copy value={text(e.body)} id={e.id} />
      {e.state === "draft" && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const queued = await edit("outreach.queue", {
              id: e.id,
              expected_version: draft.version,
              scheduled_for: new Date(reminderDate).toISOString(),
            });
            // Queueing bumps the event version: drop the pin unless send details are already typed.
            if (queued) retained.set(sentDate || reference ? { ...draft, reminderDate: "" } : null);
          }}
        >
          <label>
            Recordatorio para preparar el envío
            <input
              type="datetime-local"
              required
              value={reminderDate}
              onChange={(event) => setReminderDate(event.target.value)}
            />
          </label>
          <button {...agent("outreach", e.id, "queue")}>Poner en cola (sin enviar)</button>
        </form>
      )}
      {["draft", "queued"].includes(text(e.state)) && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const sent = await restricted(
              "outreach.mark_sent",
              {
                id: e.id,
                expected_version: draft.version,
                occurred_at: new Date(sentDate).toISOString(),
                confirmation_ref: reference,
              },
              "¿Confirmas que ya enviaste este mensaje fuera del CRM?",
            );
            if (sent) retained.set(null);
          }}
        >
          <label>
            Fecha del envío real
            <input
              type="datetime-local"
              required
              value={sentDate}
              onChange={(event) => setSentDate(event.target.value)}
            />
          </label>
          <label>
            Referencia de la entrega manual
            <input
              required
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Correo, enlace o nota de confirmación"
            />
          </label>
          {retained.value && draft.version !== e.version && (
            <p role="status">
              Este mensaje cambió desde que empezaste este borrador (versión {draft.version} →{" "}
              {e.version}).
            </p>
          )}
          <div className="actions">
            <button {...agent("outreach", e.id, "mark-sent")} disabled={!navigator.onLine}>
              Registrar envío real
            </button>
            {retained.value && draft.version !== e.version && (
              <button type="button" onClick={() => retained.set({ ...draft, version: e.version })}>
                Usar versión actual
              </button>
            )}
            {retained.value && (
              <button type="button" onClick={() => retained.set(null)}>
                Descartar borrador
              </button>
            )}
          </div>
        </form>
      )}
      {e.state === "queued" && (
        <form
          aria-label="Cancelar recordatorio"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            // Withdraws only the queued reminder; it never sends or deletes the conversation.
            const cancelled = await restricted(
              "outreach.cancel",
              {
                id: e.id,
                expected_version: e.version,
                reason: text(new FormData(form).get("reason")).trim(),
              },
              "¿Cancelar este recordatorio? El mensaje no se ha enviado y quedará registrado como cancelado.",
            );
            if (cancelled) form.reset();
          }}
        >
          <label>
            Motivo de la cancelación
            <input
              name="reason"
              required
              pattern=".*\S.*"
              maxLength={2000}
              placeholder="Por ejemplo, recordatorio duplicado"
            />
          </label>
          <button {...agent("outreach", e.id, "cancel")} disabled={!navigator.onLine}>
            Cancelar recordatorio
          </button>
        </form>
      )}
    </article>
  );
}
