import { z } from "zod";
import { uuid, timestamp, SCHEMA_VERSION } from "./domain.ts";

// Owner reads only. Active lease credentials and private file paths are not portable data.
export const backupTables = {
  companies: { columns: "*", order: ["created_at", "id"] },
  sources: { columns: "*", order: ["created_at", "id"] },
  jobs: { columns: "*", order: ["created_at", "id"] },
  contacts: { columns: "*", order: ["created_at", "id"] },
  outreach_events: { columns: "*", order: ["created_at", "id"] },
  interviews: { columns: "*", order: ["created_at", "id"] },
  resumes: {
    columns:
      "id,user_id,version,created_at,updated_at,label,country,track,checksum,media_type,active",
    order: ["created_at", "id"],
  },
  verifications: { columns: "*", order: ["created_at", "id"] },
  audit_events: { columns: "*", order: ["created_at", "id"] },
  mutation_receipts: { columns: "*", order: ["created_at", "id"] },
  legacy_links: { columns: "*", order: ["created_at", "id"] },
  crm_jobs: {
    columns:
      "id,user_id,created_at,updated_at,version,kind,state,payload,result,error,attempts,next_attempt_at,request_id",
    order: ["created_at", "id"],
  },
  automation_policies: { columns: "*", order: ["user_id"] },
  automation_profiles: { columns: "*", order: ["id"] },
  automation_work: {
    columns:
      "id,user_id,profile_id,policy_version,kind,state,job_id,version,attempts,next_attempt_at,checkpoint,error,created_at,updated_at,cycle_id,parent_work_id",
    order: ["created_at", "id"],
  },
  automation_packs: { columns: "*", order: ["created_at", "id"] },
  automation_reservations: { columns: "*", order: ["created_at", "id"] },
  automation_events: { columns: "*", order: ["created_at", "id"] },
  notification_state: { columns: "*", order: ["user_id"] },
  notification_batches: { columns: "*", order: ["created_at", "id"] },
  automation_company_guides: { columns: "*", order: ["created_at", "id"] },
  automation_interview_intents: { columns: "*", order: ["user_id", "job_id"] },
  email_preferences: { columns: "*", order: ["created_at", "id"] },
} as const;

export const backupSchema = z
  .strictObject({
    format: z.literal("job-search-crm-backup"),
    format_version: z.literal(1),
    schema_version: z.literal(SCHEMA_VERSION),
    exported_at: timestamp,
    owner_id: uuid,
    coverage: z.strictObject({
      included: z.array(z.string()),
      unavailable: z.array(z.string()),
      excluded: z.array(z.string()),
      consistency: z.literal("paginated_non_atomic"),
      restore_supported: z.literal(false),
    }),
    records: z.record(z.string(), z.array(z.record(z.string(), z.json()))),
  })
  .superRefine((value, ctx) => {
    const keys = Object.keys(value.records).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...value.coverage.included].sort()))
      ctx.addIssue({
        code: "custom",
        path: ["coverage", "included"],
        message: "La cobertura debe coincidir exactamente con las familias exportadas.",
      });
    for (const [family, rows] of Object.entries(value.records)) {
      if (!Object.hasOwn(backupTables, family))
        ctx.addIssue({
          code: "custom",
          path: ["records", family],
          message: "Familia de respaldo no compatible.",
        });
      if (rows.some((row) => row.user_id !== value.owner_id))
        ctx.addIssue({
          code: "custom",
          path: ["records", family],
          message: "El respaldo contiene registros de otro propietario.",
        });
    }
  });
export type CanonicalBackup = z.infer<typeof backupSchema>;
