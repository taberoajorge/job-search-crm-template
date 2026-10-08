import { z } from "zod";
import { uuid, timestamp, jobStage, contactStatus, entityFields } from "../domain.ts";
import { automationSchemas } from "../automation/index.ts";
import { notificationSchemas } from "../notifications.ts";
import { contactPrivacyInputs } from "../contact-privacy.ts";
const key = {
  idempotency_key: uuid.describe(
    "UUID nuevo por intención de escritura. Ante resultado incierto, repita exactamente la misma clave y payload; no la reutilice para otra intención.",
  ),
};
const expectedVersion = z
  .number()
  .int()
  .positive()
  .describe(
    "Versión actual obtenida mediante lectura. Un conflicto exige leer de nuevo y revisar el borrador; no incremente ni adivine la versión.",
  );
const eventTime = timestamp.describe(
  "Fecha real del evento en ISO 8601 con zona horaria; no invente una fecha histórica desconocida.",
);
const version = { id: uuid, expected_version: expectedVersion };
const page = {
  cursor: z
    .string()
    .max(2048)
    .describe(
      "Cursor opaco next_cursor de la respuesta anterior con los mismos filtros; omítalo en la primera página.",
    )
    .optional(),
  limit: z.number().int().min(1).max(50).default(20),
};
const query = z.string().max(500).optional();
const reason = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe(
    "Motivo humano verificable para el cambio excepcional; no sustituye evidencia del evento.",
  );
function upsert(
  name: "jobs" | "companies" | "contacts" | "sources" | "interviews",
  required: string[],
) {
  const shape = entityFields[name];
  return z
    .strictObject({
      ...key,
      id: uuid
        .describe(
          "Omita al crear; al editar use el UUID propio leído previamente. Crear requiere: " +
            required.join(", ") +
            ".",
        )
        .optional(),
      expected_version: expectedVersion.optional(),
      ...Object.fromEntries(
        Object.entries(shape).map(([k, v]) => [
          k,
          (k === "currency"
            ? v.describe(
                "Moneda de tres letras mayúsculas del importe publicado; conserve desconocidos como null, sin convertir monedas.",
              )
            : k === "salary_min" || k === "salary_max"
              ? v.describe(
                  "Importe anual publicado en la moneda indicada; si el período publicado no es anual, deje null y conserve el texto en salary_text. No convierta monedas.",
                )
              : v
          ).optional(),
        ]),
      ),
    })
    .superRefine((v, ctx) => {
      if (v.id && !v.expected_version)
        ctx.addIssue({
          code: "custom",
          path: ["expected_version"],
          message: "Obligatorio al editar",
        });
      if (!v.id) {
        for (const f of required)
          if (!(f in v))
            ctx.addIssue({ code: "custom", path: [f], message: "Obligatorio al crear" });
      }
      if (name === "jobs" && v.id && "stage" in v)
        ctx.addIssue({ code: "custom", path: ["stage"], message: "Use jobs.transition" });
      // Mirror the SQL rules (jobs_money_currency CHECK, crm_private.operation) so callers get a field.
      if (name === "jobs") {
        const job = v as Record<string, unknown>;
        const priced = job.salary_min != null || job.salary_max != null;
        // An edit that omits currency may rely on the stored one (SQL still checks); clearing it while
        // sending an amount always violates jobs_money_currency.
        if (priced && (v.id ? "currency" in job && job.currency === null : job.currency == null))
          ctx.addIssue({ code: "custom", path: ["currency"], message: "Indique la moneda" });
        if (!v.id && ["rejected", "archived"].includes(String(job.stage)))
          ctx.addIssue({
            code: "custom",
            path: ["stage"],
            message: "Cree una vacante activa y use jobs.transition con motivo",
          });
        if (
          !v.id &&
          ["applied", "invited", "messaged", "replied", "interview", "offer"].includes(
            String(job.stage),
          ) &&
          job.applied_at == null
        )
          ctx.addIssue({
            code: "custom",
            path: ["applied_at"],
            message: "Fecha de solicitud obligatoria",
          });
        if (v.id && "applied_at" in job && job.applied_at === null)
          ctx.addIssue({
            code: "custom",
            path: ["applied_at"],
            message: "Use una corrección explícita para conservar la evidencia",
          });
      }
      if (
        name === "jobs" &&
        "salary_min" in v &&
        "salary_max" in v &&
        typeof v.salary_min === "number" &&
        typeof v.salary_max === "number" &&
        v.salary_min > v.salary_max
      )
        ctx.addIssue({ code: "custom", path: ["salary_max"], message: "Debe superar el mínimo" });
    });
}
const legacyRecord = z
  .strictObject({
    entity_type: z.enum([
      "companies",
      "sources",
      "jobs",
      "contacts",
      "outreach_events",
      "interviews",
      "resumes",
      "verifications",
    ]),
    legacy_id: z.string().min(1).max(500),
    data: z.record(z.string(), z.unknown()),
  })
  .superRefine((record, ctx) => {
    const shape = entityFields[record.entity_type];
    const schema = z.strictObject({
      id: uuid,
      ...Object.fromEntries(Object.entries(shape).map(([name, field]) => [name, field.optional()])),
    });
    const result = schema.safeParse(record.data);
    if (!result.success)
      for (const issue of result.error.issues)
        ctx.addIssue({ code: "custom", path: ["data", ...issue.path], message: issue.message });
    const required: Record<keyof typeof entityFields, string[]> = {
      companies: ["name"],
      sources: ["name", "kind"],
      jobs: ["company_id", "title"],
      contacts: ["company_id", "name"],
      outreach_events: ["channel", "kind", "state", "body"],
      interviews: ["job_id", "state", "timezone"],
      resumes: ["label", "storage_path", "checksum", "media_type"],
      verifications: ["status", "checked_at", "notes"],
    };
    for (const field of required[record.entity_type])
      if (
        record.data[field] === undefined ||
        record.data[field] === null ||
        record.data[field] === ""
      )
        ctx.addIssue({
          code: "custom",
          path: ["data", field],
          message: "Obligatorio en la importación",
        });
    if (record.entity_type === "outreach_events" && !record.data.contact_id && !record.data.job_id)
      ctx.addIssue({
        code: "custom",
        path: ["data", "job_id"],
        message: "Se requiere vacante o contacto",
      });
    if (
      record.entity_type === "verifications" &&
      Boolean(record.data.job_id) === Boolean(record.data.company_id)
    )
      ctx.addIssue({
        code: "custom",
        path: ["data", "job_id"],
        message: "Elija exactamente una vacante o empresa",
      });
  });
export const operationSchemas = {
  ...contactPrivacyInputs,
  ...automationSchemas,
  ...notificationSchemas,
  "search.semantic": z.strictObject({
    entity_type: z.enum(["jobs", "contacts", "companies"]),
    embedding: z
      .array(z.number())
      .min(1)
      .max(4096)
      .describe(
        "Vector finito y no nulo generado por el mismo modelo y dimensión que los embeddings almacenados. Esta herramienta no lo genera.",
      ),
    model: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Identificador exacto del modelo que produjo embedding; debe coincidir con el índice propio.",
      ),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  "jobs.list": z
    .strictObject({
      ...page,
      stage: jobStage.optional(),
      company_id: uuid.optional(),
      query,
      // Empty text would become ilike '%%' and silently drop jobs without a location.
      location_query: z.string().trim().min(1).max(500).optional(),
      salary_min: z.number().finite().nonnegative().describe("Importe anual.").optional(),
      salary_max: z.number().finite().nonnegative().describe("Importe anual.").optional(),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .describe(
          "Moneda de tres letras mayúsculas; obligatoria al filtrar importes anuales. No convierte monedas.",
        )
        .optional(),
      salary_known: z.boolean().optional(),
      sort: z.enum(["created_desc", "posted_desc"]).optional(),
      added_from: timestamp.optional(),
      added_before: timestamp.optional(),
      posted_from: z.iso.date().optional(),
      posted_to: z.iso.date().optional(),
    })
    .superRefine((v, ctx) => {
      if (v.added_from && v.added_before && Date.parse(v.added_from) >= Date.parse(v.added_before))
        ctx.addIssue({
          code: "custom",
          path: ["added_before"],
          message: "Intervalo de incorporación inválido",
        });
      if (v.posted_from && v.posted_to && v.posted_from > v.posted_to)
        ctx.addIssue({
          code: "custom",
          path: ["posted_to"],
          message: "Intervalo de publicación inválido",
        });
      const bounded = v.salary_min !== undefined || v.salary_max !== undefined;
      if (bounded && !v.currency)
        ctx.addIssue({ code: "custom", path: ["currency"], message: "Indique la moneda" });
      if (bounded && v.salary_known === false)
        ctx.addIssue({
          code: "custom",
          path: ["salary_known"],
          message: "Los importes requieren sueldo con cifras",
        });
      if (v.salary_min !== undefined && v.salary_max !== undefined && v.salary_min > v.salary_max)
        ctx.addIssue({ code: "custom", path: ["salary_max"], message: "Debe superar el mínimo" });
    }),
  "jobs.get": z.strictObject({ id: uuid }),
  "jobs.upsert": upsert("jobs", ["company_id", "title"]),
  "jobs.transition": z.strictObject({
    ...key,
    ...version,
    stage: jobStage,
    reason: reason.optional(),
    applied_at: eventTime
      .describe(
        "Fecha real de solicitud con zona horaria; obligatoria para applied. No presente solicitudes mediante este cambio de etapa.",
      )
      .optional(),
  }),
  "companies.list": z.strictObject({ ...page, query }),
  "companies.upsert": upsert("companies", ["name"]),
  "companies.merge": z.strictObject({
    ...key,
    source_id: uuid,
    source_version: z.number().int().positive(),
    target_id: uuid,
    target_version: z.number().int().positive(),
    reason,
    confirmation: z.literal(true),
  }),
  "companies.archive": z.strictObject({
    ...key,
    ...version,
    reason,
    confirmation: z.literal(true),
  }),
  "companies.preview_merge": z.strictObject({ source_id: uuid, target_id: uuid }),
  "companies.preview_archive": z.strictObject({ id: uuid }),
  "companies.health": z.strictObject({ id: uuid }),
  "contacts.search": z.strictObject({
    ...page,
    query,
    company_id: uuid.optional(),
    job_id: uuid.optional(),
    status: contactStatus.optional(),
  }),
  "contacts.upsert": upsert("contacts", ["company_id", "name"]),
  "outreach.list": z.strictObject({
    ...page,
    job_id: uuid.optional(),
    contact_id: uuid.optional(),
    state: entityFields.outreach_events.state.optional(),
  }),
  "outreach.draft": z
    .strictObject({
      ...key,
      body: entityFields.outreach_events.body,
      channel: entityFields.outreach_events.channel,
      kind: entityFields.outreach_events.kind,
      contact_id: uuid.optional(),
      job_id: uuid.optional(),
      resume_id: uuid.optional(),
    })
    .refine((v) => Boolean(v.contact_id || v.job_id), {
      path: ["job_id"],
      message: "Se requiere contacto o vacante",
    })
    // LinkedIn invitation notes are capped at 300 characters, like contacts.draft_note.
    .refine((v) => v.kind !== "invitation" || v.body.length <= 300, {
      path: ["body"],
      message: "La nota de invitación admite 300 caracteres",
    }),
  "outreach.queue": z.strictObject({
    ...key,
    ...version,
    scheduled_for: eventTime.describe(
      "Fecha del recordatorio humano con zona horaria; la cola no envía mensajes.",
    ),
  }),
  // Withdraws a queued human reminder (e.g. a duplicate follow-up); the event stays as cancelled.
  "outreach.cancel": z.strictObject({
    ...key,
    ...version,
    reason: reason.describe(
      "Motivo humano de la cancelación (por ejemplo, recordatorio duplicado); queda en la auditoría.",
    ),
  }),
  "outreach.mark_sent": z.strictObject({
    ...key,
    ...version,
    occurred_at: eventTime,
    confirmation_ref: reason.describe(
      "Referencia a evidencia de un envío humano ya realizado fuera del CRM; nunca un envío planeado ni una credencial.",
    ),
  }),
  "outreach.record_response": z.strictObject({
    ...key,
    contact_id: uuid,
    body: entityFields.outreach_events.body,
    occurred_at: eventTime,
    job_id: uuid.optional(),
  }),
  "interviews.list": z.strictObject({
    ...page,
    job_id: uuid.optional(),
    state: entityFields.interviews.state.optional(),
  }),
  "interviews.upsert": upsert("interviews", ["job_id", "state", "timezone"]),
  "resumes.list": z.strictObject({
    ...page,
    country: query,
    track: query,
    active: z.boolean().optional(),
  }),
  "resumes.get_download": z.strictObject({ id: uuid }),
  "resumes.finalize": z.strictObject({ ...key, ...entityFields.resumes }),
  "sources.list": z.strictObject({ ...page, query }),
  "sources.upsert": upsert("sources", ["name", "kind"]),
  "verifications.record": z
    .strictObject({
      ...key,
      ...entityFields.verifications,
      checked_at: eventTime.describe(
        "Fecha real de comprobación con zona horaria; adjunte evidencia y conserve desconocidos explícitos.",
      ),
      job_id: uuid.optional(),
      company_id: uuid.optional(),
      evidence_url: entityFields.verifications.evidence_url.optional(),
      source_id: uuid.optional(),
    })
    .refine((v) => Boolean(v.job_id) !== Boolean(v.company_id), {
      path: ["job_id"],
      message: "Elija exactamente una vacante o empresa",
    }),
  "dashboard.summary": z
    .strictObject({ from: timestamp.optional(), to: timestamp.optional() })
    .refine((v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to), {
      path: ["to"],
      message: "from debe preceder a to",
    }),
  "tasks.submit": z.discriminatedUnion("kind", [
    z.strictObject({
      ...key,
      kind: z.literal("bulk_import"),
      payload: z.strictObject({
        import_namespace: z.string().min(1).max(500),
        records: z.array(legacyRecord).min(1).max(50),
      }),
    }),
    z.strictObject({
      ...key,
      kind: z.literal("embed_records"),
      payload: z.strictObject({
        records: z
          .array(
            z.strictObject({ entity_type: z.enum(["jobs", "companies", "contacts"]), id: uuid }),
          )
          .min(1)
          .max(50),
      }),
    }),
  ]),
  "tasks.get": z.strictObject({ task_id: uuid }),
  "tasks.cancel": z.strictObject({
    ...key,
    task_id: uuid,
    expected_version: expectedVersion,
  }),
  "push.subscribe": z.strictObject({
    ...key,
    endpoint: z.url().startsWith("https://"),
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
    device_label: z.string().max(500).optional(),
  }),
  // SQL treats a missing selector as "every device", so exactly one is required.
  "push.deactivate": z
    .strictObject({
      ...key,
      endpoint: z.url().startsWith("https://").optional(),
      id: uuid.optional(),
    })
    .refine((v) => (v.endpoint === undefined) !== (v.id === undefined), {
      path: ["endpoint"],
      message: "Indique endpoint o id",
    }),
} as const;
export type Operation = keyof typeof operationSchemas;
export function parseOperation(name: string, input: unknown) {
  if (!Object.hasOwn(operationSchemas, name))
    throw new Error("VALIDATION_ERROR: Operación desconocida");
  const parsed = operationSchemas[name as Operation].parse(input);
  if (name === "automation.commit") {
    const commit = automationSchemas["automation.commit"].parse(parsed);
    if (
      commit.operation === "jobs.upsert" &&
      (commit.input.applied_at != null ||
        (commit.input.stage != null &&
          !["radar", "review", "ready"].includes(String(commit.input.stage))))
    )
      throw new Error("Automation cannot invent applications or close jobs through upsert");
    if (
      commit.operation === "contacts.upsert" &&
      commit.input.status != null &&
      commit.input.status !== "uncontacted"
    )
      throw new Error("Automation cannot infer contact events");
    if (
      commit.operation === "contacts.upsert" &&
      commit.input.id != null &&
      Object.keys(commit.input).some(
        (k) => !["id", "expected_version", "job_id", "idempotency_key"].includes(k),
      )
    )
      throw new Error("Automation may only link an existing contact to a job");
    if (
      commit.operation === "jobs.transition" &&
      !["review", "ready", "archived"].includes(String(commit.input.stage))
    )
      throw new Error("Automation transition outside preparation/closure boundary");
    operationSchemas[commit.operation].parse(commit.input);
  }
  return parsed;
}
