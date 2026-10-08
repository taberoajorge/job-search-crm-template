import { useEffect, useState } from "react";
import { useRead } from "../shared/state/crm";
import { labels, text } from "../shared/state/model";
import { Badge, NavLink, Preview, Status } from "../shared/ui/controls";
import type { RecordData } from "../shared/api/client";
export function Dashboard({
  navigate,
}: {
  navigate: (screen: string, section?: string, job?: string) => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const summary = useRead<Record<string, unknown>>("dashboard.summary");
  const workspace = summary.data?.workspace as
    | { followup_count: number; featured_jobs: RecordData[]; upcoming_interviews: RecordData[] }
    | undefined;
  const featured = workspace?.featured_jobs ?? [];
  const funnel = (summary.data?.funnel || {}) as Record<string, number>;
  const planned = workspace?.upcoming_interviews ?? [];
  // The server groups by stage, so a stage absent from a loaded summary has zero jobs.
  const counts = (summary.data?.counts_by_stage ||
    summary.data?.by_stage ||
    summary.data?.stages) as Record<string, number> | undefined;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Resumen</h1>
        </div>
        <NavLink
          className="button primary"
          href="/?screen=pipeline"
          go={() => navigate("pipeline")}
        >
          Ver pipeline
        </NavLink>
      </div>
      <section className="summary-callout">
        <div>
          <h2>
            {workspace
              ? `${workspace.followup_count} ${workspace.followup_count === 1 ? "seguimiento" : "seguimientos"} por revisar`
              : summary.isPending
                ? "Cargando seguimientos…"
                : summary.isError
                  ? "No se pudo cargar el conteo de seguimientos"
                  : "Conteo de seguimientos no disponible"}
          </h2>
          <p>
            Contactos por escribir o retomar: conexiones pendientes e invitaciones o mensajes sin
            respuesta.
          </p>
        </div>
        <NavLink
          className="button"
          href="/?screen=outreach&section=followups"
          go={() => navigate("outreach", "followups")}
        >
          Revisar seguimientos
        </NavLink>
      </section>
      <div className="metrics">
        {["radar", "applied", "interview", "offer"].map((stage) => (
          <article className="card" key={stage}>
            <p className="caption">{labels[stage]}</p>
            <strong>{counts ? (counts[stage] ?? 0) : "—"}</strong>
            <p>Conteo del servidor</p>
          </article>
        ))}
      </div>
      <Status query={summary} />

      <h2>Oportunidades actualizadas recientemente</h2>
      <p>
        Hasta tres oportunidades abiertas, ordenadas por su última modificación. Incluye vacantes
        sin aplicar.
      </p>
      <div className="cards">
        {featured.map((j) => (
          <article className="card" key={j.id}>
            <Badge value={j.stage} />
            <h3>{text(j.title)}</h3>
            <p>{text(j.location)}</p>
            <p>
              {recentTime(
                recentEvent(j.id, summary.data?.recent_updates)?.occurred_at ?? text(j.updated_at),
                now,
              )}
            </p>
            <p>{recentChange(j.id, summary.data?.recent_updates)}</p>
          </article>
        ))}
      </div>
      {workspace && !summary.isError && !featured.length && (
        <p>
          No hay oportunidades abiertas cargadas. Abre Pipeline para agregar o revisar vacantes.
        </p>
      )}
      {!workspace && summary.data && (
        <p>El servidor no ofrece el resumen de oportunidades recientes. Consulta Pipeline.</p>
      )}
      <h2>Próximas entrevistas</h2>
      <div className="dashboard-interviews">
        {planned.map((i) => (
          <article className="card" key={i.id}>
            <strong>
              {i.scheduled_at
                ? new Date(text(i.scheduled_at)).toLocaleString("es-MX", {
                    timeZone: text(i.timezone) || "UTC",
                  })
                : "Fecha por confirmar"}
            </strong>
            <p>
              {text(i.timezone)}
              {text(i.next_step) ? ` · ${text(i.next_step)}` : ""}
            </p>
            {!!i.job_id && (
              <NavLink
                href={`/?screen=pipeline&job=${text(i.job_id)}&section=interviews`}
                go={() => navigate("pipeline", "interviews", text(i.job_id))}
              >
                {text(featured.find((job) => job.id === i.job_id)?.title) || "Ver vacante"}
              </NavLink>
            )}
          </article>
        ))}
      </div>
      {workspace && !summary.isError && !planned.length && (
        <p>No hay entrevistas futuras registradas. Programa una desde Entrevistas.</p>
      )}
      {!workspace && summary.data && (
        <p>El servidor no ofrece el resumen de próximas entrevistas. Consulta Entrevistas.</p>
      )}
      {summary.data && (
        <section>
          <h2>Aplicaciones y avance</h2>
          <div className="actions">
            <p>
              <strong>{text(summary.data.dated_applications)}</strong> aplicaciones con fecha
              registrada
            </p>
            <Preview title="Cómo se cuentan las aplicaciones" trigger="¿Qué significa?">
              <p>
                Cuenta las vacantes con una fecha de aplicación guardada, incluso si ya fueron
                rechazadas o archivadas. No significa que la fecha se haya comprobado con la
                empresa.
              </p>
              <p>
                {text(summary.data.unknown_application_dates)} vacantes en etapas de aplicación o
                posteriores no tienen fecha registrada y se cuentan por separado.
              </p>
              <h3>Avance registrado</h3>
              <p>
                El embudo cuenta oportunidades distintas que han llegado a cada etapa mediante
                cambios registrados en el CRM. Una oportunidad puede aparecer en varias etapas;
                estos números no se suman y no son los estados actuales del pipeline. La importación
                histórica no inventa transiciones.
              </p>
              <dl>
                {Object.entries(funnel).map(([stage, count]) => (
                  <div key={stage}>
                    <dt>{labels[stage] || stage}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
              </dl>
              {!Object.keys(funnel).length && (
                <p>Todavía no hay cambios de etapa registrados para construir este avance.</p>
              )}
            </Preview>
          </div>
        </section>
      )}
    </>
  );
}

function recentTime(value: string, now: number) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Fecha no disponible";
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
  return `${minutes < 60 ? `Hace ${minutes} minutos` : minutes < 1440 ? `Hace ${Math.floor(minutes / 60)} horas` : `Hace ${Math.floor(minutes / 1440)} días`} · ${new Date(value).toLocaleString("es-MX", { timeZoneName: "short" })}`;
}
const changedFieldLabels: Record<string, string> = {
  title: "puesto",
  stage: "etapa",
  location: "ubicación",
  salary_text: "salario informado",
  salary_min: "salario mínimo",
  salary_max: "salario máximo",
  currency: "moneda",
  posting_url: "publicación",
  description_summary: "descripción",
  notes: "notas",
  resume_id: "CV asociado",
  viewed: "revisión",
  viewed_at: "fecha de revisión",
  applied_at: "fecha de aplicación",
};
function recentEvent(id: string, updates: unknown) {
  return (
    updates as
      | {
          items?: {
            entity_id: string;
            entity_type: string;
            history: string;
            action: string;
            occurred_at: string;
            changed_fields: string[];
          }[];
        }
      | undefined
  )?.items?.find(
    (event) =>
      event.entity_id === id && event.entity_type === "jobs" && event.history === "recorded",
  );
}
function recentChange(id: string, updates: unknown) {
  const event = recentEvent(id, updates);
  if (!event) return "Detalle del cambio no disponible en el historial.";
  const fields = event.changed_fields.map((field) => changedFieldLabels[field]).filter(Boolean);
  return fields.length
    ? `Cambio registrado: ${fields.join(", ")}`
    : "Actualización registrada de la oportunidad.";
}
