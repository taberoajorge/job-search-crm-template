import { z } from "zod";
import { entityFields, uuid, timestamp, errorSchema, JOB_STAGES } from "../domain.ts";
import {
  policySchema,
  workSchema,
  packSchema,
  companyGuideSchema,
  confirmedContextSchema,
  roundContextSchema,
  profileId,
} from "../automation/index.ts";
import { notificationOutputs } from "../notifications.ts";
import { contactPrivacyOutputs, erasedReplay } from "../contact-privacy.ts";
const common = {
  id: uuid,
  user_id: uuid,
  created_at: timestamp,
  updated_at: timestamp,
  version: z.number().int().positive(),
};
// Contract-change checklist (outputs are validated by the Edge, the web app and MCP clients):
// 1. SQL rows (to_jsonb) use z.object, which strips undeclared columns, so a new column cannot
//    break reads on an already-deployed Edge; sql-parity.test.ts then requires declaring it here.
// 2. A new output key starts .optional(); a required key, even .nullable(), breaks every consumer
//    that validates older rows, fixtures or mocks. Make it required only after they all send it.
// 3. Never narrow an enum or bound that stored rows may already hold; widen SQL and zod together.
// 4. Land the migration and regenerated database.ts first, then contracts, Edge and web mocks.
export const recordSchemas = {
  companies: z.object({ ...common, ...entityFields.companies }),
  sources: z.object({ ...common, ...entityFields.sources }),
  jobs: z.object({ ...common, ...entityFields.jobs }),
  contacts: z.object({ ...common, ...entityFields.contacts }),
  outreach_events: z.object({ ...common, ...entityFields.outreach_events }),
  interviews: z.object({ ...common, ...entityFields.interviews }),
  resumes: z.object({ ...common, ...entityFields.resumes }),
  verifications: z.object({ ...common, ...entityFields.verifications }),
};
const resume = recordSchemas.resumes.omit({ storage_path: true });
const changedJob = z.strictObject({
  id: uuid,
  version: z.number().int().positive(),
  stage: entityFields.jobs.stage,
});
const page = (record: z.ZodType) =>
  z.strictObject({
    items: z.array(record),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
  });
const count = z.number().int().nonnegative();
const stageCounts = z.strictObject(
  Object.fromEntries(JOB_STAGES.map((stage) => [stage, count.optional()])),
);
const task = z.strictObject({
  id: uuid,
  created_at: timestamp,
  updated_at: timestamp,
  version: z.number().int().positive(),
  kind: z.enum(["bulk_import", "embed_records"]),
  state: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  attempts: count,
  result: z.json().nullable(),
  error: z.json().nullable(),
  next_attempt_at: timestamp.nullable(),
});
const withVerification = (schema: z.ZodObject) =>
  schema.extend({ verification: recordSchemas.verifications.nullable() });
const withTriage = (schema: z.ZodObject) =>
  schema.extend({
    triage: z
      .strictObject({
        state: z.string(),
        updated_at: timestamp,
        stale: z.boolean(),
        jev: z.record(z.string(), z.json()).nullable(),
      })
      .nullable()
      .optional(),
  });
const success: Record<string, z.ZodType> = {
  ...contactPrivacyOutputs,
  ...notificationOutputs,
  "search.semantic": page(
    z.strictObject({
      record: z.union([recordSchemas.jobs, recordSchemas.contacts, recordSchemas.companies]),
      score: z.number().nullable(),
      verification: recordSchemas.verifications.nullable(),
    }),
  ),
  "jobs.list": page(withTriage(withVerification(recordSchemas.jobs))),
  "jobs.get": withTriage(
    recordSchemas.jobs.extend({
      contacts: z.array(recordSchemas.contacts),
      interviews: z.array(recordSchemas.interviews),
      verification: recordSchemas.verifications.nullable(),
    }),
  ),
  "jobs.upsert": recordSchemas.jobs.extend({ duplicate_hints: z.array(uuid).optional() }),
  "jobs.transition": z.strictObject({ job: recordSchemas.jobs, audit_event_id: uuid }),
  "companies.list": page(withVerification(recordSchemas.companies)),
  "companies.upsert": recordSchemas.companies,
  "companies.merge": recordSchemas.companies,
  "companies.archive": z.strictObject({
    company: recordSchemas.companies,
    affected: z.strictObject({ jobs: count, contacts: count, outreach: count }),
  }),
  "companies.preview_merge": z.strictObject({
    source_version: z.number().int().positive(),
    target_version: z.number().int().positive(),
    jobs: count,
    contacts: count,
  }),
  "companies.preview_archive": z.strictObject({
    version: z.number().int().positive(),
    jobs: count,
    contacts: count,
    outreach: count,
  }),
  "push.subscribe": z.strictObject({
    id: uuid,
    active: z.boolean(),
    version: z.number().int().positive(),
  }),
  "push.deactivate": z.strictObject({ active: z.literal(false) }),
  "companies.health": z.strictObject({
    active_jobs: count,
    last_outreach: timestamp.nullable(),
    sent: count,
    responded: count,
  }),
  "contacts.search": page(withVerification(recordSchemas.contacts)),
  "contacts.upsert": z.strictObject({
    contact: z.union([recordSchemas.contacts, erasedReplay]),
    changed_jobs: z.array(changedJob),
  }),
  "outreach.list": page(recordSchemas.outreach_events),
  "outreach.draft": z.union([recordSchemas.outreach_events, erasedReplay]),
  "outreach.queue": z.union([recordSchemas.outreach_events, erasedReplay]),
  "outreach.cancel": z.union([recordSchemas.outreach_events, erasedReplay]),
  "outreach.mark_sent": z.union([recordSchemas.outreach_events, erasedReplay]),
  "outreach.record_response": z.strictObject({
    event: z.union([recordSchemas.outreach_events, erasedReplay]),
    contact: z.union([recordSchemas.contacts, erasedReplay]),
    changed_jobs: z.array(changedJob),
  }),
  "interviews.list": page(recordSchemas.interviews),
  "interviews.upsert": z.union([recordSchemas.interviews, erasedReplay]),
  "resumes.list": page(resume),
  "resumes.finalize": resume,
  "resumes.get_download": z.strictObject({
    url: z.url(),
    expires_in: z.number().int().min(1).max(300),
    expires_at: timestamp,
  }),
  "sources.list": page(recordSchemas.sources),
  "sources.upsert": recordSchemas.sources,
  "verifications.record": recordSchemas.verifications,
  "dashboard.summary": z.strictObject({
    counts_by_stage: stageCounts,
    unknown_application_dates: count,
    dated_applications: count,
    funnel: stageCounts,
    workspace: z
      .strictObject({
        followup_count: count,
        featured_jobs: z.array(recordSchemas.jobs).max(3),
        upcoming_interviews: z.array(recordSchemas.interviews).max(3),
      })
      .optional(),
    recent_updates: z
      .strictObject({
        items: z
          .array(
            z.strictObject({
              event_id: uuid,
              entity_type: z.string().min(1).max(100),
              entity_id: uuid,
              action: z.string().min(1).max(200),
              occurred_at: timestamp,
              changed_fields: z.array(z.string().min(1).max(100)).max(100),
              history: z.enum(["recorded", "unavailable"]),
            }),
          )
          .max(12),
        limit: z.literal(12),
        history_scope: z.literal("canonical_audit"),
      })
      .optional(),
  }),
  "tasks.submit": z.strictObject({
    task_id: uuid,
    state: z.literal("queued"),
    version: z.number().int().positive(),
  }),
  "tasks.get": task,
  "tasks.cancel": task,
};
export const automationPack = z.object({
  id: uuid,
  user_id: uuid,
  job_id: uuid,
  resume_id: uuid,
  version: z.number().int().positive(),
  job_version: z.number().int().positive(),
  resume_version: z.number().int().positive(),
  company_version: z.number().int().positive(),
  content: packSchema,
  model: z.string(),
  effort: z.enum(["low", "medium", "high"]),
  created_at: timestamp,
});
Object.assign(success, {
  "automation.status": z.strictObject({
    policy: policySchema.nullable(),
    policy_version: z.number().int().nonnegative(),
    server_time: timestamp,
    heartbeat_at: timestamp.nullable(),
    executor_status: z.string().nullable(),
    executor_stale: z.boolean(),
    profiles: z.array(
      z.object({
        user_id: uuid,
        id: profileId,
        resume_id: uuid,
        criteria: z.record(z.string(), z.json()),
        next_due_at: timestamp,
        next_revalidation_at: timestamp,
      }),
    ),
    work: z.array(workSchema),
    spend: z.strictObject({ daily: z.number().nonnegative(), monthly: z.number().nonnegative() }),
  }),
  "automation.configure": z.strictObject({
    version: z.number().int().positive(),
    policy: policySchema,
  }),
  "automation.trigger": z.strictObject({ work_ids: z.array(uuid) }),
  "automation.claim": z.strictObject({ work: workSchema.nullable() }),
  "automation.checkpoint": z.strictObject({ work: workSchema }),
  "automation.heartbeat": z.strictObject({ server_time: timestamp }),
  "automation.reserve": z.strictObject({ request_id: uuid, reserved_usd: z.number().positive() }),
  "automation.commit": z.strictObject({
    result: z.union([
      success["companies.upsert"]!,
      success["sources.upsert"]!,
      success["jobs.upsert"]!,
      success["jobs.transition"]!,
      success["contacts.upsert"]!,
      success["outreach.draft"]!,
      success["verifications.record"]!,
    ]),
  }),
  "automation.company-guide.get": z.strictObject({
    guide: z
      .object({
        id: uuid,
        company_id: uuid,
        version: z.number().int().positive(),
        company_version: z.number().int().positive(),
        content: companyGuideSchema,
        created_at: timestamp,
      })
      .nullable(),
    stale: z.boolean(),
  }),
  "automation.company-guide.save": z.strictObject({
    guide: z.object({
      id: uuid,
      company_id: uuid,
      version: z.number().int().positive(),
      company_version: z.number().int().positive(),
      content: companyGuideSchema,
      created_at: timestamp,
    }),
    stale: z.boolean(),
  }),
  "automation.pack.get": z.strictObject({
    pack: automationPack.nullable(),
    stale: z.boolean(),
    preparation: z
      .object({
        state: z.string(),
        phase: z.string().nullable(),
        error: z.string().nullable(),
        updated_at: timestamp,
        paused: z.boolean(),
        active: z.boolean(),
        context_revision: z.string(),
        preparation_context: confirmedContextSchema,
        rounds: z.array(roundContextSchema).max(20),
      })
      .nullable()
      .optional(),
  }),
  "automation.pack.save": z.strictObject({ pack: automationPack, stale: z.boolean() }),
});
export const outputSchemas = Object.fromEntries(
  Object.entries(success).map(([name, schema]) => [
    name,
    z.union([schema, z.strictObject({ error: errorSchema })]),
  ]),
) as Record<string, z.ZodType>;
