import type { RecordData } from "../shared/api/client";
import { useLookupRecords } from "../shared/state/crm";
import { labels, text } from "../shared/state/model";
import {
  agent,
  Badge,
  Editor,
  enumOptions,
  ExternalLink,
  options,
  Status,
  type Field,
} from "../shared/ui/controls";
import { CollectionPager, LookupStatus, useCollectionPage } from "../shared/ui/collections";
// The server pages interviews by creation; load them all and page an agenda instead: planned by
// date first (unscheduled last), then the rest newest first.
// ponytail: client-side sort of the whole list; add a server sort if interviews grow into the hundreds.
export function agendaOrder(a: RecordData, b: RecordData) {
  const planned = Number(b.state === "planned") - Number(a.state === "planned");
  if (planned) return planned;
  const [x, y] = [Date.parse(text(a.scheduled_at)), Date.parse(text(b.scheduled_at))];
  if (Number.isNaN(x) || Number.isNaN(y)) return Number(Number.isNaN(x)) - Number(Number.isNaN(y));
  return a.state === "planned" ? x - y : y - x;
}
export function Interviews() {
  const loaded = useLookupRecords("interviews.list");
  const interviews = { ...loaded, records: [...loaded.records].sort(agendaOrder) };
  const jobs = useLookupRecords("jobs.list");
  const contacts = useLookupRecords("contacts.search");
  const page = useCollectionPage(interviews);
  const fields = (record?: RecordData): Field[] => [
    { name: "job_id", label: "Vacante", required: true, options: options(jobs.records, "title") },
    { name: "scheduled_at", label: "Fecha y hora local", type: "datetime-local" },
    { name: "timezone", label: "Zona horaria IANA", required: true },
    {
      name: "state",
      label: "Estado",
      required: true,
      options: enumOptions(["planned", "completed", "cancelled"]),
    },
    {
      name: "interviewer_ids",
      label: "Contactos participantes",
      multiple: true,
      dependsOn: "job_id",
      options: [
        ...jobs.records.flatMap((job) =>
          contacts.records
            .filter(
              (contact) =>
                // Archived contacts stay only where they were already recorded.
                (!contact.archived_at &&
                  (contact.job_id === job.id || contact.company_id === job.company_id)) ||
                (record?.job_id === job.id &&
                  (record.interviewer_ids as string[] | undefined)?.includes(contact.id)),
            )
            .map((contact) => ({
              value: contact.id,
              label: [text(contact.name), text(contact.role)].filter(Boolean).join(" · "),
              group: job.id,
            })),
        ),
        ...((record?.interviewer_ids as string[] | undefined) ?? [])
          .filter((id) => !contacts.records.some((contact) => contact.id === id))
          .map((id) => ({
            value: id,
            label: "Participante registrado (datos no disponibles)",
            group: text(record?.job_id),
          })),
      ],
    },
    {
      name: "language",
      label: "Idioma confirmado",
      options: [
        { value: "es", label: "Español" },
        { value: "en", label: "English" },
      ],
    },
    {
      name: "format",
      label: "Tipo de ronda",
      options: enumOptions(["hr", "technical", "system_design", "product", "manager", "other"]),
    },
    { name: "interviewer_notes", label: "Participantes y contexto" },
    { name: "meeting_url", label: "Enlace de reunión", type: "url" },
    { name: "notes", label: "Notas de la entrevista", type: "textarea" },
    { name: "next_step", label: "Siguiente paso", type: "textarea" },
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Entrevistas</h1>
          <p className="screen-lead">Prepara cada conversación y registra el siguiente paso.</p>
        </div>
      </div>
      <div className="interview-workspace">
        <section aria-label="Programar entrevista">
          <LookupStatus query={jobs} label="vacantes" />
          <LookupStatus query={contacts} label="contactos" />
          <Editor
            entity="interviews"
            operation="interviews.upsert"
            title="Programar entrevista"
            fields={fields()}
            disabled={
              // Offline, a partial catalog cannot complete; edit with what is cached.
              jobs.isFetching ||
              contacts.isFetching ||
              (navigator.onLine && (jobs.hasNextPage || contacts.hasNextPage))
            }
            initial={{
              state: "planned",
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }}
          />
        </section>
        <section aria-label="Agenda de entrevistas">
          <Status query={interviews} />
          {["planned", "completed", "cancelled"].map((state) => {
            const records = page.records.filter((record) => record.state === state);
            return records.length ? (
              <section key={state} aria-label={`${labels[state]} en esta página`}>
                <h2 className="group-heading">
                  <Badge value={state} />
                  <span>{records.length} en esta página</span>
                </h2>
                <div className="compact-records">
                  {records.map((i) => (
                    <article
                      className="card compact-record"
                      key={i.id}
                      {...agent("interviews", i.id, "card")}
                    >
                      <div className="compact-record-main">
                        <h3>
                          {text(jobs.records.find((j) => j.id === i.job_id)?.title) || "Entrevista"}
                        </h3>
                        <p>
                          {i.scheduled_at
                            ? new Date(text(i.scheduled_at)).toLocaleString("es-MX", {
                                timeZone: text(i.timezone) || "UTC",
                              })
                            : "Fecha por confirmar"}
                        </p>
                        <small>{text(i.timezone)}</small>
                        <details>
                          <summary>Preparación y participantes</summary>
                          <p>
                            Participantes:{" "}
                            {((i.interviewer_ids as string[]) || [])
                              .map(
                                (id) =>
                                  text(contacts.records.find((c) => c.id === id)?.name) ||
                                  (contacts.isFetching || contacts.hasNextPage
                                    ? "Cargando participante…"
                                    : "Participante registrado (datos no disponibles)"),
                              )
                              .join(", ")}{" "}
                            {text(i.interviewer_notes)}
                          </p>
                          {Boolean(i.notes) && <p>{text(i.notes)}</p>}
                        </details>
                        <p className="next-step">
                          <strong>Siguiente paso: </strong>
                          {text(i.next_step) || "Por definir"}
                        </p>
                      </div>
                      <div className="compact-record-actions">
                        <ExternalLink href={i.meeting_url}>Entrar a la reunión</ExternalLink>
                        <Editor
                          entity="interviews"
                          operation="interviews.upsert"
                          record={i}
                          title="Editar entrevista"
                          fields={fields(i)}
                          disabled={
                            jobs.isFetching ||
                            contacts.isFetching ||
                            (navigator.onLine && (jobs.hasNextPage || contacts.hasNextPage))
                          }
                        />
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null;
          })}
          <CollectionPager page={page} label="entrevistas" />
        </section>
      </div>
    </>
  );
}
