import { z } from "zod";
export const JOB_STAGES = [
  "radar",
  "review",
  "ready",
  "applied",
  "invited",
  "messaged",
  "replied",
  "interview",
  "offer",
  "rejected",
  "archived",
] as const;
export const CONTACT_STATUSES = [
  "uncontacted",
  "invited",
  "connected",
  "messaged",
  "replied",
  "interview",
  "no_response",
] as const;
export const SOURCE_KINDS = ["ats", "recruiter", "referral", "aggregator", "manual"] as const;
export const jobStage = z.enum(JOB_STAGES);
export const contactStatus = z.enum(CONTACT_STATUSES);
// SQL filters compare ids as lowercase text, so an uppercase id would silently match nothing.
export const uuid = z.uuid().overwrite((v) => v.toLowerCase());
// Published JSON Schema and runtime must agree (MCP clients validate with ajv-formats):
// date-time there requires seconds, so runtime does too, matching the SQL validators.
export const timestamp = z.iso
  .datetime({ offset: true })
  .refine((v) => /T\d{2}:\d{2}:\d{2}/.test(v), "Incluya segundos y zona horaria");
// Mirrors SQL `!~* '^https?://[^[:space:]]+$'` (case-insensitive) and publishes that pattern, not
// format "uri": RFC 3986 "uri" rejects stored IRIs (e.g. accented LinkedIn slugs) that runtime
// accepts. JSON Schema patterns take no flags, so the case-insensitive scheme is spelled out.
export const safeUrl = z
  .string()
  .regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\/\S+$/, "Use una URL http o https")
  .refine((v) => URL.canParse(v), "Use una URL http o https");
// SQL requires an exact pg_timezone_names entry; Intl alone also accepts lowercase names and
// offsets. Canonical-case IANA segments known to Intl satisfy both (no posix/, right/, Factory).
export const timeZone = z
  .string()
  .regex(/^[A-Z][\w+-]*(\/[A-Z][\w+-]*)*$/, "Zona horaria IANA inválida")
  .refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, "Zona horaria IANA inválida");
// Mirrors SQL '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' so stored values always read back.
export const email = z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Correo inválido");
const text = z.string().max(100_000);
const label = z.string().trim().min(1).max(500);
const nullableText = text.nullable();
const nullableId = uuid.nullable();
const nullableTime = timestamp.nullable();
const nullableUrl = safeUrl.nullable();
export const entityFields = {
  companies: {
    name: label,
    domain: nullableText,
    website_url: nullableUrl,
    linkedin_url: nullableUrl,
    type: nullableText,
    product: nullableText,
    archived_at: nullableTime,
  },
  sources: { name: label, kind: z.enum(SOURCE_KINDS), url: nullableUrl },
  jobs: {
    company_id: uuid,
    title: label,
    stage: jobStage,
    source_id: nullableId,
    source_posting_id: nullableText,
    posting_url: nullableUrl,
    description_summary: nullableText,
    salary_text: nullableText,
    salary_min: z.number().nonnegative().nullable(),
    salary_max: z.number().nonnegative().nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    location: nullableText,
    fit_score: z.number().min(0).max(10).nullable(),
    fit_raw: nullableText,
    posted_on: z.iso.date().nullable(),
    applied_at: nullableTime,
    applied_date_precision: z.enum(["day", "instant", "approximate"]).nullable(),
    notes: text,
    viewed: z.boolean(),
    viewed_at: nullableTime,
    resume_id: nullableId,
  },
  contacts: {
    company_id: uuid,
    job_id: nullableId,
    name: label,
    role: nullableText,
    email: email.nullable(),
    linkedin_url: nullableUrl,
    status: contactStatus,
    priority: z.number().int().positive().nullable(),
    invite_at: nullableTime,
    last_interacted_at: nullableTime,
    draft_note: z.string().max(300),
    draft_message: text,
    queued_at: nullableTime,
    resume_id: nullableId,
    notes: text,
    archived_at: nullableTime,
  },
  outreach_events: {
    contact_id: nullableId,
    job_id: nullableId,
    channel: z.enum(["manual", "email", "linkedin"]),
    kind: z.enum(["application", "invitation", "message", "followup", "response"]),
    state: z.enum(["draft", "queued", "sent", "failed", "responded", "cancelled"]),
    body: text,
    scheduled_for: nullableTime,
    occurred_at: nullableTime,
    resume_id: nullableId,
    external_ref: nullableText,
    error: nullableText,
  },
  interviews: {
    job_id: uuid,
    scheduled_at: nullableTime,
    timezone: timeZone,
    state: z.enum(["planned", "completed", "cancelled"]),
    language: z.enum(["es", "en"]).nullable().optional(),
    format: z
      .enum(["hr", "technical", "system_design", "product", "manager", "other"])
      .nullable()
      .optional(),
    interviewer_ids: z.array(uuid).max(100),
    interviewer_notes: text,
    meeting_url: nullableUrl,
    notes: text,
    next_step: nullableText,
  },
  resumes: {
    label,
    country: nullableText,
    track: nullableText,
    storage_path: z.string().min(1).max(1024),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    media_type: z.enum([
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]),
    active: z.boolean(),
  },
  verifications: {
    job_id: nullableId,
    company_id: nullableId,
    status: z.enum(["pending", "partial", "confirmed", "ambiguous", "closed"]),
    checked_at: timestamp,
    evidence_url: nullableUrl,
    source_id: nullableId,
    notes: text,
  },
};
export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "RATE_LIMITED",
  "TEMPORARY_FAILURE",
] as const;
export const errorSchema = z.strictObject({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  field: z.string().optional(),
  retryable: z.boolean(),
  // 0 = no row yet (SQL CONFLICT on a first automation policy or pack).
  current_version: z.number().int().nonnegative().optional(),
});
export type CrmError = z.infer<typeof errorSchema>;
export type JobStage = z.infer<typeof jobStage>;
export type ContactStatus = z.infer<typeof contactStatus>;
export const JOB_STAGE_LABELS: Record<JobStage, string> = {
  radar: "Radar",
  review: "Por revisar",
  ready: "Lista",
  applied: "Aplicada",
  invited: "Invitación enviada",
  messaged: "Mensaje enviado",
  replied: "Respondió",
  interview: "Entrevista",
  offer: "Oferta",
  rejected: "Rechazada",
  archived: "Archivada",
};
export const CONTACT_STATUS_LABELS: Record<ContactStatus, string> = {
  uncontacted: "Sin contactar",
  invited: "Invitación enviada",
  connected: "Conectado",
  messaged: "Mensaje enviado",
  replied: "Respondió",
  interview: "Entrevista",
  no_response: "Sin respuesta",
};
export const SCHEMA_VERSION = 1;
export function requiresTransitionReason(from: JobStage, to: JobStage) {
  return (
    ["offer", "rejected", "archived"].includes(from) ||
    JOB_STAGES.indexOf(to) < JOB_STAGES.indexOf(from)
  );
}
export function automaticJobStage(from: JobStage, status: ContactStatus): JobStage {
  const target = {
    invited: "invited",
    connected: "invited",
    messaged: "messaged",
    replied: "replied",
    interview: "interview",
  } as const;
  const to = target[status as keyof typeof target];
  return to &&
    ["applied", "invited", "messaged", "replied", "interview"].includes(from) &&
    JOB_STAGES.indexOf(to) > JOB_STAGES.indexOf(from)
    ? to
    : from;
}
