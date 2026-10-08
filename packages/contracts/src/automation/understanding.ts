import { z } from "zod";
import { safeUrl, timestamp, uuid } from "../domain.ts";

export const explanationSchema = z
  .strictObject({
    // SQL validate_explanation bounds trimmed text; trim here so both accept the same values.
    explanation_es: z.string().trim().min(1).max(8000),
    explanation_en: z.string().trim().min(1).max(8000),
    coverage: z.enum(["supported", "partial", "unknown", "conflicting"]),
    evidence: z
      .array(
        z.strictObject({
          url: safeUrl,
          quote: z.string().trim().min(1).max(3000),
          checked_at: timestamp,
        }),
      )
      .max(8),
  })
  .refine(
    (s) => s.coverage !== "supported" || s.evidence.length > 0,
    "Supported explanations require inspected evidence",
  );

export const companyGuideSchema = z.strictObject({
  depth: z.enum(["initial", "application", "interview"]),
  offering: explanationSchema,
  customers: explanationSchema,
  revenue: explanationSchema,
  workflow: explanationSchema,
  technology: explanationSchema,
  hiring_process: explanationSchema,
  example: explanationSchema,
  example_kind: z.enum(["published", "illustrative", "unknown"]),
  gaps: z.array(z.string().min(1).max(2000)).max(20),
  review_status: z.literal("needs_review"),
});
export const roleGuideSchema = z.strictObject({
  area: explanationSchema,
  contribution: explanationSchema,
  requirements: z
    .array(
      z.strictObject({
        requirement: z.string().min(1).max(2000),
        cv_evidence: z.string().max(3000).nullable(),
        gap: z.string().max(3000).nullable(),
      }),
    )
    .max(20),
});
export const confirmedContextSchema = z
  .array(
    z
      .strictObject({
        topic: z.enum(["english_level", "departure", "career_goals", "experience", "interests"]),
        fact: z.string().min(1).max(3000),
        confirmed: z.literal(true),
      })
      .refine(
        (f) => f.topic !== "english_level" || f.fact.length <= 200,
        "English level exceeds 200 characters",
      ),
  )
  .max(20);
export const roundContextSchema = z.strictObject({
  id: uuid,
  version: z.number().int().positive(),
  state: z.enum(["planned", "completed", "cancelled"]),
  scheduled_at: timestamp.nullable(),
  timezone: z.string().min(1).max(200),
  interviewer_ids: z.array(uuid).max(100),
  language: z.enum(["es", "en"]).nullable(),
  format: z.enum(["hr", "technical", "system_design", "product", "manager", "other"]).nullable(),
});
export const communicationSchema = z.strictObject({
  english_level: z.string().max(200).nullable(),
  explain_back_es: z.string().min(1).max(8000),
  explain_back_en: z.string().min(1).max(8000),
  vocabulary: z
    .array(z.strictObject({ term: z.string().max(200), meaning_es: z.string().max(1000) }))
    .max(20),
  clarification_en: z.array(z.string().min(1).max(1000)).max(10),
  stories: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(500),
        outline_es: z.string().min(1).max(5000),
        outline_en: z.string().min(1).max(5000),
        evidence: z.string().min(1).max(3000),
      }),
    )
    .max(8),
});
export type CompanyGuide = z.infer<typeof companyGuideSchema>;
export type RoundContext = z.infer<typeof roundContextSchema>;
