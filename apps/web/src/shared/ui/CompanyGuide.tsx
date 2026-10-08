import type { CompanyGuide } from "@crm/contracts";
import { useRead, useRestricted } from "../state/crm";
import { useRetained } from "../state/recovery";
import { ExternalLink, Status } from "./controls";

const titles = {
  offering: "Qué ofrece",
  customers: "Clientes y usuarios",
  revenue: "Cómo genera ingresos",
  workflow: "Cómo funciona el producto o servicio",
  technology: "Dónde interviene la tecnología",
  hiring_process: "Proceso de selección publicado",
  example: "Un ejemplo concreto",
};
export function Explanation({
  title,
  section,
  language = "es",
}: {
  title: string;
  section: CompanyGuide["offering"];
  language?: string;
}) {
  return (
    <section className="practice-question">
      <h3>{title}</h3>
      {section.coverage !== "supported" && (
        <p className="caption">
          {
            {
              partial: "Evidencia parcial",
              unknown: "Pendiente de verificar",
              conflicting: "Fuentes contradictorias",
            }[section.coverage]
          }
        </p>
      )}
      <p className="preserve-text">
        {language === "en" ? section.explanation_en : section.explanation_es}
      </p>
      {!!section.evidence.length && (
        <details>
          <summary>Fuentes y fecha de comprobación</summary>
          {section.evidence.map((e, i) => (
            <div key={i}>
              <ExternalLink href={e.url}>Consultar fuente</ExternalLink>
              <p className="caption">{new Date(e.checked_at).toLocaleString("es-MX")}</p>
              <blockquote>{e.quote}</blockquote>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
export function CompanyExplanation({
  guide,
  language = "es",
}: {
  guide: CompanyGuide;
  language?: string;
}) {
  return (
    <>
      <p className="caption">
        Guía {guide.depth === "interview" ? "para entrevista" : "para revisar la oportunidad"}.
        Pendiente de revisión de utilidad.
      </p>
      {Object.entries(titles).map(([key, title]) => (
        <Explanation
          key={key}
          title={title}
          language={language}
          section={guide[key as keyof typeof titles]}
        />
      ))}
      {guide.example_kind === "illustrative" && (
        <p>El ejemplo ilustra el funcionamiento; no es un caso real confirmado.</p>
      )}
      {!!guide.gaps.length && (
        <details>
          <summary>Información por confirmar</summary>
          <ul>
            {guide.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
export function CompanyUnderstanding({ companyId }: { companyId: string }) {
  const query = useRead<any>("automation.company-guide.get", { company_id: companyId });
  return (
    <article className="card">
      <h2>Entender la empresa</h2>
      <Status query={query} />
      {query.data?.stale && (
        <p role="status">La empresa cambió; esta guía requiere actualización.</p>
      )}
      {query.data?.guide ? (
        <>
          <p className="caption">Versión de la guía {query.data.guide.version}</p>
          <CompanyExplanation guide={query.data.guide.content} />
        </>
      ) : (
        !query.isPending && (
          <p>Aún falta una explicación investigada del negocio y su producto o servicios.</p>
        )
      )}
    </article>
  );
}
export function PreparationRequest({ jobId, preparation }: { jobId: string; preparation?: any }) {
  const request = useRestricted();
  const draft = useRetained<Record<string, string>>(`interview-context:${jobId}`);
  const facts =
    draft.value ??
    Object.fromEntries(
      (preparation?.preparation_context ?? []).map((fact: { topic: string; fact: string }) => [
        fact.topic,
        fact.fact,
      ]),
    );
  const fields = {
    english_level: "Nivel de inglés confirmado",
    departure: "Cómo explicas tu salida anterior",
    career_goals: "Qué buscas en tu siguiente etapa",
    experience: "Ejemplo real adicional de tu experiencia",
    interests: "Intereses que quieras practicar",
  };
  const requestPreparation = async () => {
    const preparation_context = Object.entries(facts)
      .filter(([, fact]) => fact.trim())
      .map(([topic, fact]) => ({ topic, fact: fact.trim(), confirmed: true }));
    const result = await request(
      "automation.trigger",
      {
        scope: "interview",
        job_id: jobId,
        on_demand: true,
        ...(preparation_context.length ? { preparation_context } : {}),
      },
      "Preparar esta entrevista con las fuentes y el presupuesto guardados, sin cambiar la pausa de automatización. ¿Confirmas los datos personales que añadiste?",
    );
    if (result) draft.set(null);
  };
  return (
    <article className="card">
      <h2>Preparar esta entrevista</h2>
      <p>
        Al registrar una invitación o ronda se solicita preparación automáticamente. Puedes
        solicitarla también sin una cita.
      </p>
      {preparation && (
        <p role="status">
          {preparation.paused ? "Automatización pausada · " : ""}
          {(
            {
              queued: "En cola",
              running: "Preparando",
              waiting: "En espera",
              completed: "Material preparado; revisa su contenido",
              blocked: "Requiere revisión",
              failed: "Preparación fallida",
              cancelled: "Solicitud cancelada",
            } as Record<string, string>
          )[preparation.active === false ? "cancelled" : preparation.state] ?? preparation.state}
          {preparation.error === "BUDGET_EXHAUSTED" && " · Presupuesto agotado"}
          {preparation.phase === "research-wait" && " · Investigando fuentes"}
        </p>
      )}
      <details>
        <summary>Datos personales opcionales para practicar</summary>
        <p>
          Incluye solo hechos tuyos confirmados. Se usan para preparar respuestas y no se envían a
          Exa.
        </p>
        {Object.entries(fields).map(([name, label]) => (
          <label key={name}>
            {label}
            <textarea
              value={facts[name] ?? ""}
              maxLength={name === "english_level" ? 200 : 3000}
              onChange={(e) => draft.set({ ...facts, [name]: e.target.value })}
            />
          </label>
        ))}
        {draft.error && <p role="alert">{draft.error}</p>}
      </details>
      <button
        disabled={!navigator.onLine || !draft.ready}
        onClick={() => void requestPreparation()}
      >
        Preparar entrevista
      </button>
    </article>
  );
}
