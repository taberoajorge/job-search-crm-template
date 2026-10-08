import { EvidenceNotes } from "../shared/ui/EvidenceNotes";
import {
  CompanyUnderstanding,
  CompanyExplanation,
  Explanation,
  PreparationRequest,
} from "../shared/ui/CompanyGuide";
import { JevClassification } from "../shared/ui/JevClassification";
import { NotificationChanges, VacancyNotificationHistory } from "../shared/ui/notifications";
import { useId, useState } from "react";
import { useRead, useRecords, useLookupRecords, useRestricted } from "../shared/state/crm";
import { stages, text } from "../shared/state/model";
import {
  DetailTabs,
  Badge,
  Editor,
  enumOptions,
  ExternalLink,
  NavLink,
  options,
  Status,
} from "../shared/ui/controls";
import type { RecordData } from "../shared/api/client";
import { CollectionPager, LookupStatus, useCollectionPage } from "../shared/ui/collections";
export function JobDetail({
  id,
  back,
  backHref = "/?screen=pipeline",
  initialSection,
  notificationId,
}: {
  id: string;
  back: () => void;
  /** Real destination of `back`, e.g. the company-filtered pipeline the owner came from. */
  backHref?: string;
  initialSection?: string | null;
  notificationId?: string | null;
}) {
  const validSection = (value?: string | null) =>
    ["overview", "people", "preparation", "interviews", "changes"].includes(value ?? "")
      ? value!
      : "overview";
  const [section, setSection] = useState(() => validSection(initialSection));
  const selectSection = (value: string) => {
    setSection(value);
    const url = new URL(location.href);
    url.searchParams.set("section", value);
    history.pushState({}, "", url);
  };
  const tabId = useId();
  const restricted = useRestricted();
  const companies = useLookupRecords("companies.list");
  const sources = useLookupRecords("sources.list");
  const resumes = useLookupRecords("resumes.list");
  const pack = useRead<any>("automation.pack.get", { job_id: id });
  const job = useRead<RecordData>("jobs.get", { id });
  const contacts = useLookupRecords("contacts.search", { job_id: id });
  const interviews = useRecords("interviews.list", { job_id: id });
  const contactPage = useCollectionPage(contacts, id);
  const interviewPage = useCollectionPage(interviews, id);
  if (!job.data)
    return (
      <>
        <NavLink className="button" href={backHref} go={back}>
          ← Volver al pipeline
        </NavLink>
        <Status query={job} />
      </>
    );
  const j = job.data;
  return (
    <>
      <NavLink className="button" href={backHref} go={back}>
        ← Volver al pipeline
      </NavLink>
      <Status query={job} />
      <p className="caption">
        Observado: {new Date(job.dataUpdatedAt).toLocaleString("es-MX")}
        {job.isError ? " · Actualización fallida; datos guardados" : ""}
      </p>
      <JevClassification job={j} expanded />
      <div className="page-heading">
        <div>
          <Badge value={j.stage} />
          <h1>{text(j.title)}</h1>
          <p>
            {text(j.location)} · {text(j.salary_text)}
          </p>
          <p className="caption">
            Fuente:{" "}
            {text(sources.records.find((source) => source.id === j.source_id)?.name) ||
              (sources.isError
                ? "Fuente registrada no disponible"
                : sources.isFetching || sources.hasNextPage
                  ? "Consultando fuente…"
                  : j.source_id
                    ? "Fuente registrada sin nombre disponible"
                    : "Sin fuente registrada")}
          </p>
        </div>
        <Editor
          entity="jobs"
          operation="jobs.upsert"
          record={j}
          title="Editar oportunidad"
          fields={[
            { name: "title", label: "Puesto", required: true },
            {
              name: "company_id",
              label: "Empresa",
              required: true,
              options: options(companies.records),
            },
            { name: "source_id", label: "Fuente", options: options(sources.records) },
            { name: "source_posting_id", label: "ID de la publicación en la fuente" },
            { name: "posting_url", label: "Enlace de la vacante", type: "url" },
            {
              name: "resume_id",
              label: "CV usado para aplicar",
              options: options(resumes.records, "label"),
            },
            { name: "fit_score", label: "Afinidad (0 a 10)", type: "number", max: 10 },
            { name: "salary_min", label: "Salario mínimo", type: "number" },
            { name: "salary_max", label: "Salario máximo", type: "number" },
            { name: "currency", label: "Moneda ISO (MXN, USD, EUR)" },
            { name: "description_summary", label: "Descripción", type: "textarea" },
            { name: "location", label: "Ubicación" },
            { name: "salary_text", label: "Salario" },
            { name: "notes", label: "Notas", type: "textarea" },
          ]}
        />
      </div>
      <DetailTabs
        id={tabId}
        value={section}
        onChange={selectSection}
        items={[
          ["overview", "Vacante"],
          ["people", "Personas"],
          ["preparation", "Preparación"],
          ["interviews", "Entrevistas"],
          ["changes", "Cambios"],
        ]}
      />
      <section
        className="section-stack"
        role="tabpanel"
        id={`${tabId}-changes-panel`}
        aria-labelledby={`${tabId}-changes-tab`}
        hidden={section !== "changes"}
      >
        {section === "changes" && (
          <>
            <h2>Cambios registrados</h2>
            <p>
              Este historial describe lo guardado en su fecha. La sección Vacante muestra los datos
              actuales (versión {j.version}).
            </p>
            {notificationId ? (
              <NotificationChanges id={notificationId} jobId={id} />
            ) : (
              <VacancyNotificationHistory jobId={id} />
            )}
          </>
        )}
      </section>
      <section
        className="section-stack"
        role="tabpanel"
        id={`${tabId}-overview-panel`}
        aria-labelledby={`${tabId}-overview-tab`}
        hidden={section !== "overview"}
      >
        <article className="card">
          <h2>El siguiente paso</h2>
          <p>Revisa la oportunidad y su evidencia antes de avanzar en el proceso.</p>
          <ExternalLink href={j.posting_url}>Abrir vacante</ExternalLink>
          <p>
            Aplicación:{" "}
            {j.applied_at
              ? new Date(text(j.applied_at)).toLocaleString("es-MX")
              : ["radar", "review", "ready"].includes(text(j.stage))
                ? "Sin aplicación registrada"
                : "Fecha desconocida"}
          </p>
          <Editor
            entity="jobs"
            operation="jobs.transition"
            record={j}
            title="Cambiar etapa"
            fields={[
              { name: "stage", label: "Nueva etapa", required: true, options: enumOptions(stages) },
              { name: "reason", label: "Motivo de la transición o corrección", required: true },
              {
                name: "applied_at",
                label: "Fecha real de aplicación (confirma antes de avanzar)",
                type: "datetime-local",
              },
            ]}
          />
        </article>
        <CompanyUnderstanding companyId={String(j.company_id)} />
        <details className="card">
          <summary>Descripción de la vacante</summary>
          <p className="preserve-text">
            {text(j.description_summary) || "Sin descripción registrada."}
          </p>
        </details>
        <details className="card">
          <summary>Notas y material anterior</summary>
          <p className="preserve-text">{text(j.notes) || "Sin notas registradas."}</p>
        </details>
        <details className="card">
          <summary>Verificación de la oportunidad</summary>
          <EvidenceNotes value={text((j.verification as Record<string, unknown> | null)?.notes)} />
          <details className="evidence-registration">
            <summary>Registrar nueva evidencia</summary>
            <form
              aria-label="Registrar nueva evidencia"
              onSubmit={async (event) => {
                event.preventDefault();
                const element = event.currentTarget;
                const form = new FormData(element);
                const recorded = await restricted(
                  "verifications.record",
                  {
                    job_id: id,
                    status: form.get("status"),
                    checked_at: new Date().toISOString(),
                    notes: form.get("notes"),
                    ...(form.get("evidence_url") ? { evidence_url: form.get("evidence_url") } : {}),
                  },
                  "¿Registrar esta evidencia de verificación?",
                );
                // A kept form invites a second identical evidence row.
                if (recorded) element.reset();
              }}
            >
              <label>
                Estado de verificación
                <select name="status" required>
                  {["pending", "partial", "confirmed", "ambiguous", "closed"].map((value) => (
                    <option key={value} value={value}>
                      {
                        (
                          {
                            pending: "Pendiente",
                            partial: "Parcial",
                            confirmed: "Confirmada",
                            ambiguous: "Ambigua",
                            closed: "Cerrada",
                          } as Record<string, string>
                        )[value]
                      }
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Evidencia (enlace)
                <input name="evidence_url" type="url" />
              </label>
              <label>
                Notas de verificación
                <textarea name="notes" rows={6} required />
              </label>
              <button disabled={!navigator.onLine}>Registrar evidencia</button>
            </form>
          </details>
        </details>
        <LookupStatus query={companies} label="empresas" />
        <LookupStatus query={sources} label="fuentes" />
        <LookupStatus query={resumes} label="currículums" />
      </section>
      <section
        className="section-stack"
        role="tabpanel"
        id={`${tabId}-preparation-panel`}
        aria-labelledby={`${tabId}-preparation-tab`}
        hidden={section !== "preparation"}
      >
        <PreparationRequest jobId={id} preparation={pack.data?.preparation} />
        <Status query={pack} />
        {/* The empty-pack copy is only true after a successful response. */}
        {pack.data !== undefined && <PreparationPack data={pack.data} />}
      </section>
      <section
        className="section-stack"
        role="tabpanel"
        id={`${tabId}-people-panel`}
        aria-labelledby={`${tabId}-people-tab`}
        hidden={section !== "people"}
      >
        <h2>Personas vinculadas</h2>
        {!contacts.isPending && !contacts.error && !contactPage.records.length && (
          <p>
            No hay personas verificadas en los datos cargados de esta vacante. La investigación
            puede estar pendiente o no haber encontrado evidencia suficiente.
          </p>
        )}
        <div className="cards">
          {contactPage.records.map((c) => (
            <article className="card" key={c.id}>
              <h3>{text(c.name)}</h3>
              <p>{text(c.role)}</p>
              <Badge value={c.status} />
              <p>
                <ExternalLink href={c.linkedin_url}>Perfil de LinkedIn</ExternalLink>
              </p>
              {!!c.email && <p>Correo registrado: {text(c.email)}</p>}
              {!!c.notes && (
                <details>
                  <summary>Evidencia y notas</summary>
                  <p className="preserve-text">{text(c.notes)}</p>
                </details>
              )}
              {!!c.draft_message && (
                <details>
                  <summary>Mensaje preparado</summary>
                  <p className="preserve-text">{text(c.draft_message)}</p>
                </details>
              )}
            </article>
          ))}
        </div>
        <Status query={contacts} empty={false} />
        <CollectionPager page={contactPage} label="personas vinculadas" />
      </section>
      <section
        className="section-stack"
        role="tabpanel"
        id={`${tabId}-interviews-panel`}
        aria-labelledby={`${tabId}-interviews-tab`}
        hidden={section !== "interviews"}
      >
        <h2>Entrevistas</h2>
        <Editor
          entity="interviews"
          operation="interviews.upsert"
          title="Programar entrevista"
          initial={{
            job_id: id,
            state: "planned",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }}
          fields={[
            {
              name: "scheduled_at",
              label: "Fecha y hora local",
              type: "datetime-local",
            },
            { name: "timezone", label: "Zona horaria IANA", required: true },
            {
              name: "interviewer_ids",
              label: "Contactos participantes",
              multiple: true,
              options: options(contacts.records.filter((c) => !c.archived_at)),
            },
            {
              name: "language",
              label: "Idioma confirmado",
              options: [
                { value: "es", label: "Español" },
                { value: "en", label: "English" },
              ],
            },
            {
              name: "format",
              label: "Tipo de ronda",
              options: enumOptions([
                "hr",
                "technical",
                "system_design",
                "product",
                "manager",
                "other",
              ]),
            },
            { name: "interviewer_notes", label: "Participantes y detalles" },
            { name: "next_step", label: "Siguiente paso" },
            { name: "notes", label: "Notas", type: "textarea" },
          ]}
        />
        <LookupStatus query={contacts} label="contactos de la vacante" />
        {interviewPage.records.map((i) => (
          <article className="card" key={i.id}>
            <h3>
              {i.scheduled_at
                ? new Date(text(i.scheduled_at)).toLocaleString("es-MX", {
                    timeZone: text(i.timezone) || "UTC",
                  })
                : "Fecha por confirmar"}
            </h3>
            <p>Zona horaria: {text(i.timezone)}</p>
            <p>
              Participantes: {text(i.interviewer_notes)}{" "}
              {((i.interviewer_ids as string[]) || [])
                .map(
                  (id) =>
                    text(contacts.records.find((c) => c.id === id)?.name) ||
                    "Participante sin datos disponibles",
                )
                .join(", ")}
            </p>
            <p>Siguiente paso: {text(i.next_step)}</p>
          </article>
        ))}
        <Status query={interviews} />
        <CollectionPager page={interviewPage} label="entrevistas vinculadas" />
      </section>
    </>
  );
}

export function PreparationPack({ data }: { data: any }) {
  const [language, setLanguage] = useState("es");
  const id = useId();
  if (!data?.pack) return <p>Aún no hay una preparación guardada para esta vacante.</p>;
  const content = data.pack.content;
  return (
    <article className="card">
      <h2>Preparación de entrevista</h2>
      {data.stale && (
        <p role="status">
          Requiere actualizar: la vacante, el CV, la guía o el contexto de entrevista cambiaron.
        </p>
      )}
      {content.content_version === 2 && (
        <p className="caption">
          Versión {data.pack.version} ·{" "}
          {content.depth === "interview" ? "Entrevista" : "Preparación preliminar"} · Cobertura
          parcial, pendiente de revisión.
        </p>
      )}
      {content.rounds?.map((round: any) => (
        <p key={round.id}>
          Ronda {round.format ?? "por confirmar"} ·{" "}
          {round.scheduled_at
            ? new Date(round.scheduled_at).toLocaleString("es-MX", { timeZone: round.timezone })
            : "Fecha por confirmar"}{" "}
          · Idioma {round.language ?? "por confirmar"}
        </p>
      ))}
      <p>
        Preguntas previstas, no confirmadas por la empresa. La práctica no está registrada como
        completada.
      </p>
      <DetailTabs
        id={id}
        value={language}
        onChange={setLanguage}
        items={[
          ["es", "Español"],
          ["en", "English"],
        ]}
      />
      {["es", "en"].map((lang) => (
        <section
          key={lang}
          lang={lang}
          className="section-stack"
          role="tabpanel"
          hidden={language !== lang}
          id={`${id}-${lang}-panel`}
          aria-labelledby={`${id}-${lang}-tab`}
        >
          {content.content_version === 2 && (
            <>
              <CompanyExplanation guide={content.company_guide} language={lang} />
              <Explanation
                title={lang === "es" ? "El área de esta vacante" : "This role's team"}
                section={content.role_guide.area}
                language={lang}
              />
              <Explanation
                title={lang === "es" ? "Cómo contribuye al negocio" : "Business contribution"}
                section={content.role_guide.contribution}
                language={lang}
              />
              <details>
                <summary>
                  {lang === "es" ? "Requisitos y mi experiencia" : "Requirements and my experience"}
                </summary>
                {content.role_guide.requirements.map((r: any, i: number) => (
                  <div key={i}>
                    <p>{r.requirement}</p>
                    <p>{r.cv_evidence ?? "Sin evidencia confirmada en el CV"}</p>
                    {r.gap && <p>{r.gap}</p>}
                  </div>
                ))}
              </details>
              <h3>
                {lang === "es"
                  ? "Explicar la empresa con mis palabras"
                  : "Explain the company in my own words"}
              </h3>
              <p className="preserve-text">{content.communication[`explain_back_${lang}`]}</p>
              <details>
                <summary>
                  {lang === "es" ? "Historias de mi experiencia" : "Experience stories"}
                </summary>
                {content.communication.stories.map((story: any, i: number) => (
                  <div key={i}>
                    <h4>{story.title}</h4>
                    <p className="preserve-text">{story[`outline_${lang}`]}</p>
                    <small>{story.evidence}</small>
                  </div>
                ))}
              </details>
              <details>
                <summary>
                  {lang === "es" ? "Comunicación e inglés" : "Communication and English"}
                </summary>
                <p>Nivel confirmado: {content.communication.english_level ?? "Por confirmar"}</p>
                <dl>
                  {content.communication.vocabulary.map((v: any, i: number) => (
                    <div key={i}>
                      <dt>{v.term}</dt>
                      <dd>{v.meaning_es}</dd>
                    </div>
                  ))}
                </dl>
                <ul>
                  {content.communication.clarification_en.map((phrase: string, i: number) => (
                    <li key={i}>{phrase}</li>
                  ))}
                </ul>
              </details>
              <p className="caption">
                {content.depth === "interview"
                  ? "Preparación para entrevista"
                  : "Preparación preliminar"}{" "}
                · Evidencia parcial, revisar antes de practicar.
              </p>
            </>
          )}
          <h3>{lang === "es" ? "Presentación personal" : "Self introduction"}</h3>
          <p className="preserve-text">{content[`introduction_${lang}`]}</p>
          <h3>{lang === "es" ? "Preguntas de práctica" : "Practice questions"}</h3>
          {content.questions.map((q: any, index: number) => (
            <details key={index} className="practice-question">
              <summary>{q[`question_${lang}`]}</summary>
              <p className="preserve-text">{q[`answer_${lang}`]}</p>
              <small>
                {lang === "es" ? "Evidencia del CV" : "CV evidence"}: {q.cv_evidence}
              </small>
            </details>
          ))}
          <details className="practice-question">
            <summary>
              {lang === "es" ? "Preguntas para la empresa" : "Questions for the employer"}
            </summary>
            <ul>
              {content[`employer_questions_${lang}`].map((q: string, index: number) => (
                <li key={index}>{q}</li>
              ))}
            </ul>
          </details>
        </section>
      ))}
      {!!content.gaps.length && (
        <details className="practice-question">
          <summary>Pendiente de verificar</summary>
          <ul>
            {content.gaps.map((g: string, index: number) => (
              <li key={index}>{g}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
