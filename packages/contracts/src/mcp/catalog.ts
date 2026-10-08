import { z } from "zod";
import { operationSchemas, type Operation } from "./index.ts";
import { outputSchemas } from "./output.ts";

// Publishing a new operation requires an explicit description and security review.
// Company merge/archive stay in the UI flow until MCP has a bound cascade preview.
const descriptions = {
  "notifications.list":
    "Lectura: historial propio de cambios automatizados agrupados; filtros job_id/unread y cursor con los mismos filtros. Incluye versión/corte para marcar leídas; no envía correos.",
  "notifications.get":
    "Lectura: detalle histórico propio por id de lote; paginas de vacantes y cambios registrados. job_id exige pertenencia al lote; datos históricos pueden estar minimizados. No marca leído.",
  "notifications.preferences":
    "Lectura: preferencias propias de avisos agrupados y divulgación de detalles; no expone destinatarios ni credenciales.",
  "notifications.read":
    "Escritura: marca un lote propio leído/no leído con id, read, expected_version e idempotency_key; repite exactamente ante resultado incierto.",
  "notifications.mark_all":
    "Escritura: marca leído el historial propio hasta cutoff obtenido de notifications.list, con su state_version como expected_version e idempotency_key; no incluye cambios posteriores.",
  "notifications.configure":
    "Escritura: guarda consentimiento explícito live_email y disclosure generic/vacancy_summary con expected_version e idempotency_key. No cambia correo de tareas/push ni envía correo directamente.",
  "automation.status":
    "Lectura: muestra la política propia, perfiles/CVs, próxima búsqueda, trabajos y frescura del ejecutor según reloj del servidor. No consulta Windows ni ejecuta búsquedas.",
  "automation.configure":
    "Escritura: guarda política explícita, perfiles/CVs actuales, fuentes, modelo, cadencia, presupuestos recurrentes y avisos separados. Requiere expected_version e idempotency_key; pausar impide efectos nuevos y conserva investigación ya aceptada.",
  "automation.trigger":
    "Escritura: solicita discovery (vacantes nuevas), existing (investigar radar/revisión, contactos y borradores) classification (solo Jev), interview (preparación de job_id con interview_id/contexto confirmado opcionales) o all; scope omitido conserva all. on_demand=true autoriza una ejecución acotada sin cambiar la pausa. Respeta los interruptores guardados y reutiliza trabajo pendiente. Requiere idempotency_key y política guardada; no elude presupuestos ni postula a vacantes.",
  "automation.claim":
    "Escritura: el coordinador reclama un trabajo debido con lease breve, executor_id e idempotency_key. Usa reloj del servidor y recupera leases vencidos sin duplicar el trabajo.",
  "automation.checkpoint":
    "Escritura: guarda progreso/resultados propios y próximos trabajos con work_id, lease_token, expected_version e idempotency_key. Waiting libera el lease; conserva IDs de proveedores para recuperar la misma investigación.",
  "automation.heartbeat":
    "Escritura: registra estado del ejecutor propio y renueva un lease válido si se indica. Requiere executor_id e idempotency_key; no expone credenciales ni realiza búsquedas.",
  "automation.reserve":
    "Escritura: reserva coste de investigación propia contra límites diarios/mensuales incluyendo compromisos concurrentes. Requiere request_id, work_id, lease_token, expected_version e idempotency_key; no llama Exa.",
  "automation.commit":
    "Escritura: el coordinador aplica exclusivamente preparación/descubrimiento propios mediante operaciones CRM allowlisted y lease/política vigentes. Requiere work_id, lease_token, expected_version, input e idempotency_key; protege etapas aplicadas y exige cierre verificado para archivar. No envía mensajes ni postula.",
  "automation.company-guide.get":
    "Lectura: obtiene explicación investigada propia por company_id, fuentes, cobertura y versión; no realiza búsquedas.",
  "automation.company-guide.save":
    "Escritura: guarda guía empresarial propia bajo lease vigente, company_version y expected_guide_version. Requiere idempotency_key; no acepta información privada del CV.",
  "automation.pack.get":
    "Lectura: obtiene el último paquete bilingüe propio por job_id con frescura respecto a vacante/CV/empresa. Preguntas son predicciones; no registra una entrevista ni práctica.",
  "automation.pack.save":
    "Escritura: guarda versión de preparación bilingüe propia con job_id, resume_id, versiones actuales, expected_pack_version, work_id, lease_token, expected_version e idempotency_key. No inventa citas, postulaciones ni práctica completada.",
  "search.semantic":
    "Lectura: busca vacantes, empresas o contactos propios por similitud y devuelve evidencia de verificación. Requiere un vector compatible con el modelo indicado; no genera embeddings ni modifica registros.",
  "jobs.list":
    "Lectura: lista vacantes propias con filtros de etapa, empresa, texto, ubicación y sueldo. Los límites de sueldo requieren moneda. Usa next_cursor para continuar la paginación; incluye viewed y version.",
  "jobs.get": "Lectura: obtiene una vacante propia por UUID con su versión actual; no la modifica.",
  "jobs.upsert":
    "Escritura: crea o actualiza una vacante propia. Crear requiere company_id y title; actualizar requiere id y expected_version. Toda llamada requiere idempotency_key. No envía solicitudes laborales.",
  "jobs.transition":
    "Escritura: cambia la etapa de una vacante propia con id, expected_version e idempotency_key. Retroceder, reabrir o sobrescribir la fecha de solicitud requiere reason; applied requiere una fecha explícita. No presenta solicitudes ni envía mensajes.",
  "companies.list":
    "Lectura: lista empresas propias con búsqueda y paginación por cursor; devuelve sus versiones actuales.",
  "companies.upsert":
    "Escritura: crea o actualiza datos de una empresa propia. Crear requiere name; actualizar requiere id y expected_version. Requiere idempotency_key y no fusiona empresas ni archiva relaciones en cascada.",
  "companies.health":
    "Lectura: consulta la salud y vigencia de la verificación de una empresa propia por UUID; no realiza comprobaciones externas ni cambia estados.",
  "contacts.search":
    "Lectura: busca contactos propios por texto, empresa o estado con paginación por cursor. Incluye versiones; no contacta a ninguna persona.",
  "contacts.upsert":
    "Escritura: crea o actualiza un contacto propio. Crear requiere company_id y name; actualizar requiere id y expected_version. Requiere idempotency_key. El borrador de nota admite 300 caracteres; no envía mensajes ni solicita conexiones.",
  "outreach.list":
    "Lectura: lista eventos de contacto propios por vacante, contacto o estado y cursor; no envía comunicaciones.",
  "outreach.draft":
    "Escritura: guarda un borrador con body, channel, kind y al menos contact_id o job_id propios. Requiere idempotency_key; puede vincular un CV existente. Guardar el borrador no envía ningún mensaje.",
  "outreach.queue":
    "Escritura: programa un seguimiento humano de un borrador propio con scheduled_for, id, expected_version e idempotency_key. La cola es un recordatorio y no un envío automático.",
  "outreach.cancel":
    "Escritura: cancela un recordatorio humano en cola (state queued) de un evento propio con id, expected_version, reason e idempotency_key. El evento queda como cancelled con su historial y auditoría; no borra registros ni envía mensajes. No aplica a borradores ni a envíos ya registrados.",
  "outreach.mark_sent":
    "Escritura: registra un envío que una persona ya realizó fuera del CRM. Requiere id, expected_version, idempotency_key, occurred_at y confirmation_ref como evidencia. Puede actualizar la etapa vinculada; la herramienta no envía mensajes.",
  "outreach.record_response":
    "Escritura: registra una respuesta real recibida de un contacto propio, con body y occurred_at; requiere contact_id e idempotency_key. Puede vincular job_id y actualizar la etapa relacionada; no envía una respuesta externa.",
  "interviews.list":
    "Lectura: lista entrevistas propias filtradas por vacante o estado, con paginación y versiones actuales.",
  "interviews.upsert":
    "Escritura: crea o actualiza una entrevista propia. Crear requiere job_id, state y timezone; actualizar requiere id y expected_version. Requiere idempotency_key. Conserva notas y horario; no crea invitaciones externas.",
  "resumes.list":
    "Lectura: lista metadatos de CV propios por país, especialidad o activo con paginación. No devuelve archivos ni rutas privadas de almacenamiento.",
  "resumes.finalize":
    "Escritura: registra un PDF o DOCX propio ya subido al bucket privado resumes. Requiere label, country, track, storage_path, checksum SHA-256, media_type, active e idempotency_key. El servidor descarga y verifica bytes, tipo y propiedad antes de guardar; no sube archivos ni comparte el CV. Activar una versión desactiva la anterior del mismo país y especialidad; conserva sus bytes e historial.",
  "resumes.get_download":
    "Lectura: genera un enlace privado temporal para descargar un CV propio por UUID. Caduca en un máximo de cinco minutos; no lo publiques ni lo compartas con terceros. No modifica el CV.",
  "sources.list":
    "Lectura: lista fuentes propias con búsqueda y paginación; devuelve versiones actuales.",
  "sources.upsert":
    "Escritura: crea o actualiza una fuente propia. Crear requiere name y kind; actualizar requiere id y expected_version. Requiere idempotency_key; no consulta ni publica en el sitio externo.",
  "verifications.record":
    "Escritura: añade evidencia histórica de verificación propia con status y checked_at para exactamente una vacante o empresa. Requiere idempotency_key. No comprueba automáticamente sitios externos ni reemplaza evidencia anterior.",
  "dashboard.summary":
    "Lectura: devuelve métricas propias del CRM y actividad real dentro de un intervalo opcional. No infiere fechas de solicitud desconocidas ni modifica datos.",
  "tasks.submit":
    "Escritura: encola una tarea durable con idempotency_key y devuelve task_id para tasks.get. bulk_import acepta 1–50 registros normalizados con UUID inmutable y referencias existentes; puede crear registros y rechaza conflictos. embed_records procesa 1–50 registros propios mediante el proveedor configurado. No presenta solicitudes ni envía outreach; la finalización puede notificar al propietario si dio su consentimiento.",
  "tasks.get":
    "Lectura: consulta por task_id propio el estado, versión, resultado o error durable de una tarea. Úsala para comprobar la finalización aunque las notificaciones fallen.",
  "tasks.cancel":
    "Escritura: cancela una tarea propia aún en cola con task_id, expected_version e idempotency_key. No revierte registros ya importados ni cancela una tarea que el worker ya está ejecutando.",
} satisfies Partial<Record<Operation, string>>;

// Reviewed effects, not inferred from operation-name suffixes.
const readOnly = new Set([
  "automation.company-guide.get",
  "notifications.list",
  "notifications.get",
  "notifications.preferences",
  "automation.status",
  "automation.pack.get",
  "search.semantic",
  "jobs.list",
  "jobs.get",
  "companies.list",
  "companies.health",
  "contacts.search",
  "outreach.list",
  "interviews.list",
  "resumes.list",
  "resumes.get_download",
  "sources.list",
  "dashboard.summary",
  "tasks.get",
]);
// Writes that only add rows or new versions; every other write may overwrite state.
const appendOnly = new Set([
  "outreach.draft",
  "verifications.record",
  "automation.reserve",
  "automation.pack.save",
  "automation.company-guide.save",
]);
// Calls that can reach outside the CRM, directly or through work they queue: provider requests
// (embeddings, Exa/Autoapply/OpenHire research) or owner email. Outreach tools never send.
const openWorld = new Set([
  "tasks.submit",
  "automation.trigger",
  "automation.commit",
  "notifications.configure",
]);
// Clients collapse or reject a root oneOf (Claude Code shows only the first branch), so
// tasks.submit publishes one object; parseOperation still enforces the kind/payload pairing.
const submit = operationSchemas["tasks.submit"].options;
const published: Partial<Record<Operation, z.ZodType>> = {
  "tasks.submit": submit[0].extend({
    kind: z
      .enum([submit[0].shape.kind.value, submit[1].shape.kind.value])
      .describe(
        "bulk_import usa payload.import_namespace+records; embed_records usa payload.records.",
      ),
    payload: z.union([submit[0].shape.payload, submit[1].shape.payload]),
  }),
};

// Clients cache outputSchema from tools/list and this stateless server cannot announce changes, so
// the published view tolerates added keys; the Edge still validates and strips server-side.
function tolerant({ jsonSchema }: { jsonSchema: { additionalProperties?: unknown } }) {
  if (jsonSchema.additionalProperties === false) delete jsonSchema.additionalProperties;
}
// The uuid/date-time formats already carry the check; their inline regexes were ~40% of tools/list.
const json = { unrepresentable: "any", override: compact } as const;
function compact({ jsonSchema }: { jsonSchema: { format?: string; pattern?: string } }) {
  if (jsonSchema.format === "uuid" || jsonSchema.format === "date-time") delete jsonSchema.pattern;
}

export const toolCatalog = Object.entries(descriptions)
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([name, description]) => {
    const operation = name as keyof typeof descriptions;
    return {
      name,
      description,
      // Input view: defaulted fields (limit, policy flags) stay optional for callers.
      inputSchema: {
        ...z.toJSONSchema(published[operation] ?? operationSchemas[operation], {
          ...json,
          io: "input",
        }),
        type: "object",
      },
      outputSchema: {
        ...z.toJSONSchema(outputSchemas[operation]!, {
          ...json,
          override: (ctx) => {
            compact(ctx);
            tolerant(ctx);
          },
        }),
        type: "object",
      },
      annotations: {
        readOnlyHint: readOnly.has(name),
        ...(!readOnly.has(name) ? { idempotentHint: true } : {}),
        destructiveHint: !readOnly.has(name) && !appendOnly.has(name),
        openWorldHint: openWorld.has(name),
      },
    };
  });

export { outputSchemas, recordSchemas } from "./output.ts";
