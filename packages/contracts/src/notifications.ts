import { z } from "zod";
import { uuid, timestamp, errorSchema } from "./domain.ts";
const version = z.number().int().positive();
const page = {
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(2048).optional(),
};
const guarded = { idempotency_key: uuid, expected_version: version };
export const notificationSchemas = {
  "notifications.list": z.strictObject({
    ...page,
    job_id: uuid.optional(),
    unread: z.boolean().optional(),
  }),
  "notifications.get": z.strictObject({ ...page, id: uuid, job_id: uuid.optional() }),
  "notifications.preferences": z.strictObject({}),
  "notifications.read": z.strictObject({ ...guarded, id: uuid, read: z.boolean() }),
  "notifications.mark_all": z.strictObject({ ...guarded, cutoff: timestamp }),
  "notifications.configure": z.strictObject({
    ...guarded,
    live_email: z.boolean(),
    disclosure: z.enum(["generic", "vacancy_summary"]),
  }),
} as const;
// Row-shaped (to_jsonb) outputs strip undeclared columns; see the checklist in mcp/output.ts.
export const notificationStateSchema = z.object({
  user_id: uuid,
  version,
  live_email: z.boolean(),
  disclosure: z.enum(["generic", "vacancy_summary"]),
});
export const notificationBatchSchema = z.object({
  id: uuid,
  user_id: uuid,
  version,
  created_at: timestamp,
  updated_at: timestamp,
  window_start: timestamp,
  window_end: timestamp,
  read_at: timestamp.nullable(),
  vacancies: z.number().int().nonnegative(),
  open: z.boolean(),
  delivery: z.enum(["not_queued", "queued", "accepted", "failed", "cancelled"]),
  delivery_verified: z.literal(false),
});
export const notificationEventSchema = z.strictObject({
  id: uuid,
  kind: z.enum(["discovered", "prepared", "closed", "updated", "contacts", "company"]),
  created_at: timestamp,
  job_version: z.number().int().positive().nullable(),
  profile_id: z.string(),
  cycle_id: uuid.nullable(),
  work_id: uuid.nullable(),
  snapshot: z
    .strictObject({
      title: z.string(),
      company: z.string().nullable(),
      changes: z.record(z.string(), z.json()),
    })
    .nullable(),
});
const item = z.strictObject({ job_id: uuid, events: z.array(notificationEventSchema) });
export const notificationOutputs = {
  "notifications.list": z.strictObject({
    items: z.array(notificationBatchSchema),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
    state_version: version,
    cutoff: timestamp,
    unread_count: z.number().int().nonnegative(),
  }),
  "notifications.get": z.strictObject({
    batch: notificationBatchSchema,
    items: z.array(item),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  }),
  "notifications.preferences": notificationStateSchema,
  "notifications.configure": notificationStateSchema,
  "notifications.mark_all": notificationStateSchema,
  "notifications.read": notificationBatchSchema,
};
export type NotificationBatch = z.infer<typeof notificationBatchSchema>;
export type NotificationEvent = z.infer<typeof notificationEventSchema>;
export type NotificationState = z.infer<typeof notificationStateSchema>;
export type NotificationDetail = z.infer<(typeof notificationOutputs)["notifications.get"]>;
export type NotificationList = z.infer<(typeof notificationOutputs)["notifications.list"]>;
export const notificationLabels: Record<NotificationEvent["kind"], string> = {
  discovered: "Vacante encontrada",
  prepared: "Preparación lista",
  closed: "Publicación cerrada",
  updated: "Vacante actualizada",
  contacts: "Contactos encontrados",
  company: "Empresa investigada",
};
export function notificationLink(batchId: string, jobId?: string): string {
  uuid.parse(batchId);
  const params = new URLSearchParams({
    screen: jobId ? "pipeline" : "notifications",
    notification: batchId,
  });
  if (jobId) {
    uuid.parse(jobId);
    params.set("job", jobId);
    params.set("section", "changes");
  }
  return `/?${params}`;
}
// public.crm_email_preferences (task-completion email): {} reads; writes are version-guarded
// receipts, and an absent preference reads as version 0.
export const emailPreferences = {
  input: z.union([
    z.strictObject({}),
    z.strictObject({
      enabled: z.boolean(),
      expected_version: z.number().int().nonnegative(),
      idempotency_key: uuid,
    }),
  ]),
  output: z.union([
    z.strictObject({ enabled: z.boolean(), version: z.number().int().nonnegative() }),
    z.strictObject({ error: errorSchema }),
  ]),
};
