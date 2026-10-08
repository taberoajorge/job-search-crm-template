import type { RecordData } from "../api/client";
import {
  JOB_STAGES,
  CONTACT_STATUSES,
  JOB_STAGE_LABELS,
  CONTACT_STATUS_LABELS,
} from "@crm/contracts";
export const stages = JOB_STAGES;
export const statuses = CONTACT_STATUSES;
export const labels: Record<string, string> = {
  radar: "Radar",
  review: "En revisión",
  ready: "Lista para aplicar",
  applied: "Aplicada",
  invited: "Invitación enviada",
  messaged: "Mensaje enviado",
  replied: "Respondió",
  interview: "Entrevista",
  offer: "Oferta",
  rejected: "Rechazada",
  archived: "Archivada",
  uncontacted: "Sin contactar",
  connected: "Conectado",
  no_response: "Sin respuesta",
  planned: "Programada",
  completed: "Completada",
  cancelled: "Cancelada",
  draft: "Borrador",
  queued: "En cola · sin enviar",
  sent: "Enviado",
  failed: "Falló",
  responded: "Respuesta",
  manual: "Manual",
  email: "Correo",
  linkedin: "LinkedIn",
  invitation: "Invitación",
  message: "Mensaje",
  followup: "Seguimiento",
  response: "Respuesta",
  application: "Aplicación",
};
Object.assign(labels, JOB_STAGE_LABELS, CONTACT_STATUS_LABELS);
export function text(value: unknown) {
  return value == null ? "" : String(value);
}
export function followups(contacts: RecordData[], jobs: RecordData[], now = Date.now()) {
  const applied = new Set(
    jobs
      .filter((j) =>
        ["applied", "invited", "messaged", "replied", "interview"].includes(text(j.stage)),
      )
      .map((j) => j.id),
  );
  return contacts.filter(
    (c) =>
      !c.archived_at &&
      ((c.status === "uncontacted" && applied.has(text(c.job_id))) ||
        c.status === "connected" ||
        (c.status === "invited" && overdue(c.invite_at, 7, now)) ||
        (c.status === "messaged" && overdue(c.last_interacted_at, 5, now))),
  );
}
export type OutreachScope = "contact" | "vacancy" | "either";
export type OutreachProjection = RecordData & {
  contact?: RecordData;
  job?: RecordData;
  contactCompany?: RecordData;
  jobCompany?: RecordData;
  time: string;
  timeLabel: "Ocurrido" | "Programado" | "Registrado";
  overdue: boolean;
  relationshipUnavailable: boolean;
};
export function projectOutreach(
  events: RecordData[],
  contacts: RecordData[],
  jobs: RecordData[],
  companies: RecordData[],
  companyId = "",
  scope: OutreachScope = "either",
  now = Date.now(),
): OutreachProjection[] {
  const byId = (rows: RecordData[]) => new Map(rows.map((row) => [row.id, row]));
  const contactById = byId(contacts);
  const jobById = byId(jobs);
  const companyById = byId(companies);
  return events
    .map((event) => {
      const contact = contactById.get(text(event.contact_id));
      const job = jobById.get(text(event.job_id));
      const contactCompany = contact?.company_id
        ? companyById.get(text(contact.company_id))
        : undefined;
      const jobCompany = job?.company_id ? companyById.get(text(job.company_id)) : undefined;
      const contactCompanyId = text(contact?.company_id);
      const jobCompanyId = text(job?.company_id);
      const relationshipUnavailable =
        (Boolean(event.contact_id) && !contact) ||
        (Boolean(event.job_id) && !job) ||
        (Boolean(contact?.company_id) && !contactCompany) ||
        (Boolean(job?.company_id) && !jobCompany);
      const matches =
        !companyId ||
        relationshipUnavailable ||
        (scope === "contact" && contactCompanyId === companyId) ||
        (scope === "vacancy" && jobCompanyId === companyId) ||
        (scope === "either" && (contactCompanyId === companyId || jobCompanyId === companyId));
      const occurred = text(event.occurred_at);
      const scheduled = text(event.scheduled_for);
      const created = text(event.created_at);
      const time = occurred || scheduled || created;
      return {
        ...event,
        contact,
        job,
        contactCompany,
        jobCompany,
        time,
        timeLabel: occurred ? "Ocurrido" : scheduled ? "Programado" : "Registrado",
        overdue: !occurred && Boolean(scheduled) && Date.parse(scheduled) < now,
        relationshipUnavailable,
        ...(matches ? {} : { __filtered: true }),
      } as OutreachProjection & { __filtered?: boolean };
    })
    .filter((event) => !(event as OutreachProjection & { __filtered?: boolean }).__filtered)
    .sort((a, b) => {
      const at = Date.parse(a.time);
      const bt = Date.parse(b.time);
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(at) ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
}
export function outreachAgenda(events: OutreachProjection[], now = Date.now()) {
  return events
    .filter((event) => text(event.state) === "queued")
    .sort((a, b) => {
      const at = a.scheduled_for ? Date.parse(text(a.scheduled_for)) : Infinity;
      const bt = b.scheduled_for ? Date.parse(text(b.scheduled_for)) : Infinity;
      if (at !== bt) return at - bt;
      return a.id.localeCompare(b.id);
    })
    .map((event) => ({
      ...event,
      overdue: Boolean(event.scheduled_for) && Date.parse(text(event.scheduled_for)) < now,
    }));
}
export function outreachCounts(events: OutreachProjection[]) {
  return {
    people: new Set(events.map((event) => text(event.contact_id)).filter(Boolean)).size,
    events: events.length,
  };
}
function overdue(date: unknown, days: number, now: number) {
  const value = Date.parse(text(date));
  return Number.isFinite(value) && now - value > days * 86400000;
}
