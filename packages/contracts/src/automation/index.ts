import { z } from "zod";
import { uuid, timestamp, safeUrl, email, timeZone } from "../domain.ts";

import {
  companyGuideSchema,
  roleGuideSchema,
  confirmedContextSchema,
  roundContextSchema,
  communicationSchema,
} from "./understanding.ts";
export * from "./understanding.ts";

export const profileId = z.string().regex(/^(ai|general|backend|frontend)-(MX|PE)$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const profileSchema = z
  .strictObject({
    id: profileId,
    resume_id: uuid,
    checksum: digest,
    country: z.enum(["MX", "PE"]),
    track: z.enum(["ai", "general", "backend", "frontend"]),
    authorized_country: z.literal(true),
    remote: z.literal(true),
    terms: z.array(z.string().min(1).max(200)).min(1).max(12),
    exclusions: z.array(z.string().min(1).max(200)).max(20),
    allow_unknown_salary: z.boolean(),
    salary_min: z.number().nonnegative().nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    salary_period: z.enum(["hour", "month", "year"]).nullable(),
  })
  .superRefine((p, ctx) => {
    if (
      p.id !== `${p.track}-${p.country}` ||
      (p.salary_min !== null && (!p.currency || !p.salary_period))
    )
      ctx.addIssue({
        code: "custom",
        message: "Profile identity/currency/period must be explicit",
      });
  });
export const policySchema = z
  .strictObject({
    enabled: z.boolean(),
    discovery_enabled: z.boolean().default(true),
    research_enabled: z.boolean().default(true),
    jev_enabled: z.boolean().default(true),
    interval_hours: z.number().int().min(2).max(168),
    revalidate_hours: z.number().int().min(24).max(168),
    timezone: timeZone,
    profiles: z.array(profileSchema).min(1).max(8),
    sources: z
      .array(z.enum(["autoapply", "openhire", "exa"]))
      .min(1)
      .max(3),
    model: z.string().min(1).max(100),
    effort: z.enum(["low", "medium", "high"]),
    candidates_per_profile: z.number().int().min(1).max(10),
    exa_per_run_usd: z.number().min(0).max(2),
    exa_daily_usd: z.number().min(0).max(100),
    exa_monthly_usd: z.number().min(0).max(1000),
    digest_email: z.boolean(),
    closure_email: z.boolean(),
  })
  .superRefine((p, ctx) => {
    if (
      new Set(p.profiles.map((x) => x.id)).size !== p.profiles.length ||
      new Set(p.sources).size !== p.sources.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate profiles/sources" });
    if (p.sources.includes("exa") && (!p.exa_per_run_usd || !p.exa_daily_usd || !p.exa_monthly_usd))
      ctx.addIssue({ code: "custom", message: "Exa requires explicit recurring allowances" });
  });
export const questionSchema = z.strictObject({
  question_es: z.string().min(1).max(2000),
  question_en: z.string().min(1).max(2000),
  answer_es: z.string().max(5000),
  answer_en: z.string().max(5000),
  cv_evidence: z.string().min(1).max(3000),
});
const packFields = {
  introduction_es: z.string().max(5000),
  introduction_en: z.string().max(5000),
  questions: z.array(questionSchema).min(3).max(12),
  employer_questions_es: z.array(z.string().max(2000)).max(8),
  employer_questions_en: z.array(z.string().max(2000)).max(8),
  gaps: z.array(z.string().max(2000)).max(20),
  english_required: z.boolean().nullable(),
  interview_language: z.enum(["es", "en"]).nullable(),
  company_facts: z.array(z.strictObject({ fact: z.string().max(3000), url: safeUrl })).max(20),
  predictions: z.literal(true),
  practice_completed: z.literal(false),
};
export const legacyPackSchema = z
  .strictObject(packFields)
  .refine(
    (p) => p.employer_questions_es.length === p.employer_questions_en.length,
    "Question translations must align",
  );
export const interviewPackSchema = z
  .strictObject({
    ...packFields,
    content_version: z.literal(2),
    depth: z.enum(["application", "interview"]),
    coverage: z.enum(["partial", "supported"]),
    company_guide: companyGuideSchema,
    guide_version: z.number().int().positive().nullable(),
    role_guide: roleGuideSchema,
    rounds: z.array(roundContextSchema).max(20),
    context_revision: z.string().max(64),
    communication: communicationSchema,
  })
  .refine(
    (p) => p.employer_questions_es.length === p.employer_questions_en.length,
    "Question translations must align",
  );
export const packSchema = z.union([legacyPackSchema, interviewPackSchema]);
export const candidateSchema = z.strictObject({
  company: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  url: safeUrl,
  source: z.enum(["autoapply", "openhire", "exa"]),
  source_posting_id: z.string().max(500).nullable(),
  geography: z
    .strictObject({
      country: z.enum(["MX", "PE"]),
      remote: z.literal(true),
      evidence_url: safeUrl,
      quote: z.string().min(1).max(2000),
    })
    .nullable(),
  location: z.string().max(1000).nullable(),
  summary: z.string().max(10000),
  fit: z.enum(["match", "review", "mismatch"]),
  reason: z.string().max(3000),
});
export const discoverySchema = z.strictObject({
  profile_id: profileId,
  candidates: z.array(candidateSchema).max(20),
  outages: z.array(z.enum(["autoapply", "openhire", "exa"])).max(3),
});
export const preparationSchema = z.strictObject({
  invitation: z.string().max(200),
  message: z.string().max(10000),
  pack: packSchema,
  contacts: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(500),
        role: z.string().max(1000),
        linkedin_url: safeUrl,
        email: email.nullable(),
        evidence_url: safeUrl,
      }),
    )
    .max(5),
  gaps: z.array(z.string().max(2000)).max(20),
});
export const workKind = z.enum([
  "discovery",
  "revalidate",
  "research",
  "prepare",
  "interview",
  "classify",
]);
export const workState = z.enum([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);
export const workSchema = z.object({
  id: uuid,
  user_id: uuid,
  profile_id: profileId,
  policy_version: z.number().int().positive(),
  kind: workKind,
  state: workState,
  job_id: uuid.nullable(),
  version: z.number().int().positive(),
  attempts: z.number().int().nonnegative(),
  next_attempt_at: timestamp,
  lease_token: uuid.nullable(),
  lease_until: timestamp.nullable(),
  executor_id: uuid.nullable(),
  checkpoint: z.record(z.string(), z.json()),
  error: z.string().max(200).nullable(),
  created_at: timestamp,
  updated_at: timestamp,
  cycle_id: uuid.nullable(),
  parent_work_id: uuid.nullable(),
});
const key = { idempotency_key: uuid };
const leased = { work_id: uuid, lease_token: uuid, expected_version: z.number().int().positive() };
export const automationSchemas = {
  "automation.status": z.strictObject({}),
  "automation.configure": z.strictObject({
    ...key,
    expected_version: z.number().int().nonnegative(),
    policy: policySchema,
  }),
  "automation.trigger": z
    .strictObject({
      ...key,
      profile_id: profileId.optional(),
      scope: z.enum(["discovery", "existing", "classification", "interview", "all"]).optional(),
      job_id: uuid.optional(),
      interview_id: uuid.optional(),
      preparation_context: confirmedContextSchema.optional(),
      on_demand: z.boolean().optional(),
      retry_failed: z.boolean().optional(),
    })
    .superRefine((v, ctx) => {
      if (
        v.scope === "interview"
          ? !v.job_id || v.profile_id || v.retry_failed !== undefined
          : v.job_id || v.interview_id || v.preparation_context
      )
        ctx.addIssue({
          code: "custom",
          message: "Interview preparation requires a vacancy-specific scope",
        });
      // Mirrors the SQL dispatcher: on-demand runs need an explicit bounded scope; classification
      // only runs on demand. (retry_failed is accepted but unused on demand: lead-supabase-db.)
      if (
        v.on_demand &&
        !["discovery", "existing", "classification", "interview"].includes(String(v.scope))
      )
        ctx.addIssue({
          code: "custom",
          path: ["scope"],
          message: "Elija discovery, existing, classification o interview",
        });
      if (v.scope === "classification" && !v.on_demand)
        ctx.addIssue({
          code: "custom",
          path: ["on_demand"],
          message: "La clasificación requiere on_demand",
        });
    }),
  "automation.claim": z.strictObject({
    ...key,
    executor_id: uuid,
    content_version: z.literal(2).optional(),
  }),
  "automation.checkpoint": z.strictObject({
    ...key,
    ...leased,
    state: workState.exclude(["queued"]),
    checkpoint: z.record(z.string(), z.json()),
    next_attempt_at: timestamp.optional(),
    error: z.string().max(200).nullable(),
    children: z
      .array(
        z.strictObject({
          id: uuid,
          profile_id: profileId.optional(),
          kind: workKind.exclude(["classify"]),
          job_id: uuid.nullable(),
          checkpoint: z.record(z.string(), z.json()),
        }),
      )
      .max(20),
  }),
  "automation.heartbeat": z
    .strictObject({
      ...key,
      executor_id: uuid,
      status: z.enum(["online", "auth_required", "provider_error", "budget_blocked"]),
      work_id: uuid.optional(),
      lease_token: uuid.optional(),
    })
    .refine((v) => (v.work_id === undefined) === (v.lease_token === undefined), {
      path: ["lease_token"],
      message: "work_id y lease_token van juntos",
    }),
  "automation.reserve": z.strictObject({
    ...key,
    ...leased,
    request_id: uuid,
    amount_usd: z.number().positive().max(2),
  }),
  "automation.commit": z.strictObject({
    ...key,
    ...leased,
    operation: z.enum([
      "companies.upsert",
      "sources.upsert",
      "jobs.upsert",
      "jobs.transition",
      "contacts.upsert",
      "outreach.draft",
      "verifications.record",
    ]),
    input: z.record(z.string(), z.json()),
  }),
  "automation.company-guide.get": z.strictObject({ company_id: uuid }),
  "automation.company-guide.save": z.strictObject({
    ...key,
    ...leased,
    company_id: uuid,
    company_version: z.number().int().positive(),
    expected_guide_version: z.number().int().nonnegative(),
    content: companyGuideSchema,
    source_fingerprint: digest,
  }),
  "automation.pack.get": z.strictObject({ job_id: uuid }),
  "automation.pack.save": z.strictObject({
    ...key,
    ...leased,
    job_id: uuid,
    resume_id: uuid,
    job_version: z.number().int().positive(),
    resume_version: z.number().int().positive(),
    company_version: z.number().int().positive(),
    expected_pack_version: z.number().int().nonnegative(),
    content: packSchema,
    model: z.string().min(1).max(100),
    effort: z.enum(["low", "medium", "high"]),
  }),
} as const;
export type Policy = z.infer<typeof policySchema>;
export type Profile = z.infer<typeof profileSchema>;
export type Work = z.infer<typeof workSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type Preparation = z.infer<typeof preparationSchema>;
