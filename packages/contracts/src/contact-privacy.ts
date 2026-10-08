import { z } from "zod";
import { uuid, timestamp, jobStage, contactStatus } from "./domain.ts";

const version = z.number().int().positive();
const count = z.number().int().nonnegative();
export const erasedReplay = z.strictObject({
  id: uuid,
  erased: z.literal(true),
  version: version.optional(),
  company_id: uuid.optional(),
  job_id: uuid.optional(),
  contact_id: uuid.optional(),
  resume_id: uuid.optional(),
  source_id: uuid.optional(),
  entity_id: uuid.optional(),
  stage: jobStage.optional(),
  status: z
    .union([contactStatus, z.enum(["pending", "partial", "confirmed", "ambiguous", "closed"])])
    .optional(),
  state: z
    .enum([
      "draft",
      "queued",
      "sent",
      "failed",
      "responded",
      "cancelled",
      "planned",
      "running",
      "completed",
      "accepted",
    ])
    .optional(),
  applied_at: timestamp.nullable().optional(),
  // crm_private.erasure_response keeps these timestamps on minimized copies (L-09).
  created_at: timestamp.optional(),
  updated_at: timestamp.optional(),
  scheduled_at: timestamp.optional(),
  occurred_at: timestamp.optional(),
  checked_at: timestamp.optional(),
});
export const erasureInventory = z.strictObject({
  contact: z.literal(1),
  outreach: count,
  interviews: count,
  audits: count,
  receipts: count,
  import_tasks: count,
  legacy_links: count,
  embeddings: count,
  // Added by migration 20261007090200 (automation work that references the contact); optional so
  // previews from a database without that migration still parse.
  automation_work: count.optional(),
});
const disclosure = {
  inventory: erasureInventory,
  remaining_copies: z.array(z.string().max(2000)).max(50),
  limitations: z.array(z.string().max(2000)).max(50),
};
// Browser owner review only; these operations are deliberately absent from the MCP catalog.
export const contactPrivacyInputs = {
  "contacts.preview_erasure": z.strictObject({ id: uuid }),
  "contacts.erase": z.strictObject({
    id: uuid,
    expected_version: version,
    inventory_hash: z.string().regex(/^[a-f0-9]{64}$/),
    owner_reviewed: z.literal(true),
    idempotency_key: uuid,
  }),
};
export const contactPrivacyOutputs = {
  "contacts.preview_erasure": z.strictObject({
    contact_id: uuid,
    expected_version: version,
    inventory_hash: z.string().regex(/^[a-f0-9]{64}$/),
    ...disclosure,
  }),
  "contacts.erase": z.strictObject({
    contact_id: uuid,
    erased: z.literal(true),
    version,
    ...disclosure,
  }),
};
export type ContactErasurePreview = z.infer<
  (typeof contactPrivacyOutputs)["contacts.preview_erasure"]
>;
