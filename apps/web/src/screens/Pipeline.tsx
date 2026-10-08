import {
  JevClassification,
  reviewMatch,
  profileName,
  reviewPriority,
} from "../shared/ui/JevClassification";
import { useRef, useState } from "react";
import { useEdit, useLookupRecords } from "../shared/state/crm";
import { labels, stages, text } from "../shared/state/model";
import {
  agent,
  Badge,
  Editor,
  ExternalLink,
  NavLink,
  options,
  Preview,
  Status,
} from "../shared/ui/controls";
import {
  FilterDialog,
  CollectionPager,
  CompanyIdentity,
  LookupStatus,
  useCollectionPage,
} from "../shared/ui/collections";
import type { RecordData } from "../shared/api/client";
export function Pipeline({
  open,
  company: companyFilter = null,
  onCompanyChange = () => {},
}: {
  open: (id: string) => void;
  /** Company filter owned by the page URL (`?company=`), so contacts can deep-link to it. */
  company?: string | null;
  onCompanyChange?: (id: string | null) => void;
}) {
  const [filters, setFilters] = useState<Record<string, unknown>>({});
  const searchInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState("list");
  const [salaryKnown, setSalaryKnown] = useState("");
  const [filterError, setFilterError] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("jev_priority");
  const criteria = {
    ...filters,
    ...(companyFilter ? { company_id: companyFilter } : {}),
    ...(search.trim() ? { query: search.trim() } : {}),
    sort: sort === "jev_priority" ? "created_desc" : sort,
  };
  const jobs = useLookupRecords("jobs.list", criteria);
  const [jevProfile, setJevProfile] = useState("");
  const [jevCategory, setJevCategory] = useState("");
  const [jevConfidence, setJevConfidence] = useState(0);
  const visibleJobs = jobs.records
    .filter((job) => reviewMatch(job, jevProfile, jevCategory, jevConfidence))
    .sort((a, b) =>
      sort === "jev_priority" ? reviewPriority(a, jevProfile) - reviewPriority(b, jevProfile) : 0,
    );
  const [selectedStage, setSelectedStage] = useState("radar");
  const companies = useLookupRecords("companies.list");
  const sources = useLookupRecords("sources.list");
  const sourceName = (id: unknown) =>
    text(sources.records.find((source) => source.id === id)?.name) ||
    (sources.isError
      ? "Fuente registrada no disponible"
      : sources.isFetching || sources.hasNextPage
        ? "Consultando fuente…"
        : id
          ? "Fuente registrada sin nombre disponible"
          : "Sin fuente registrada");
  const page = useCollectionPage(
    { ...jobs, records: visibleJobs },
    JSON.stringify([criteria, sort, jevProfile, jevCategory, jevConfidence]),
  );
  const company = (id: unknown) => companies.records.find((c) => c.id === id);
  const companyName = text(company(companyFilter)?.name);
  // A failed lookup stops paging: report it, but do not call an existing company missing.
  const companyMissing =
    !companyName &&
    !companies.isError &&
    !companies.isPending &&
    !companies.isFetching &&
    !companies.hasNextPage;
  const filteredCompany =
    companyName ||
    (companies.isError ? "nombre no cargado" : companyMissing ? "no disponible" : "cargando…");
  return (
    <>
      <div className="page-heading">
        <h1>Pipeline</h1>
        <div className="heading-actions">
          <Editor
            entity="jobs"
            operation="jobs.upsert"
            title="Agregar oportunidad"
            fields={[
              {
                name: "company_id",
                label: "Empresa",
                required: true,
                options: options(companies.records),
              },
              { name: "title", label: "Puesto", required: true },
              { name: "posting_url", label: "Enlace de la vacante", type: "url" },
              { name: "location", label: "Ubicación" },
              { name: "notes", label: "Notas", type: "textarea" },
            ]}
          />
          <Editor
            entity="companies"
            operation="companies.upsert"
            title="Agregar empresa"
            fields={[
              { name: "name", label: "Nombre de la empresa", required: true },
              { name: "website_url", label: "Sitio web", type: "url" },
            ]}
          />
        </div>
      </div>
      <div className="collection-toolbar">
        <label className="collection-search">
          Buscar oportunidades
          <input
            ref={searchInput}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Puesto o empresa…"
          />
        </label>
        <label>
          Ordenar por
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="jev_priority">Afinidad Jev para revisión</option>
            <option value="created_desc">Últimas agregadas</option>
            <option value="posted_desc">Últimas publicadas</option>
          </select>
        </label>
        <FilterDialog
          count={Object.keys(filters).length + (companyFilter ? 1 : 0)}
          onOpen={() => {
            setSalaryKnown(
              filters.salary_known === true
                ? "known"
                : filters.salary_known === false
                  ? "unknown"
                  : "",
            );
            setFilterError("");
          }}
          onClear={() => {
            setFilters({});
            onCompanyChange(null);
            setSelectedStage("radar");
            setSalaryKnown("");
            setFilterError("");
          }}
          onApply={(form) => {
            const input: Record<string, unknown> = {};
            for (const key of ["stage", "location_query", "currency"]) {
              const value = text(form.get(key)).trim();
              if (value) input[key] = key === "currency" ? value.toUpperCase() : value;
            }
            for (const key of ["salary_min", "salary_max"])
              if (form.get(key)) input[key] = Number(form.get(key));
            if (salaryKnown) input.salary_known = salaryKnown === "known";
            const amounts = [input.salary_min, input.salary_max].filter((v) => v !== undefined);
            if (
              amounts.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0) ||
              (amounts.length > 0 && !/^[A-Z]{3}$/.test(text(input.currency))) ||
              (typeof input.salary_min === "number" &&
                typeof input.salary_max === "number" &&
                input.salary_min > input.salary_max)
            ) {
              setFilterError(
                "Usa importes positivos, mínimo menor o igual al máximo y moneda de tres letras.",
              );
              return false;
            }
            try {
              for (const key of ["posted_from", "posted_to"]) {
                const value = text(form.get(key));
                if (value) input[key] = value;
              }
              for (const [field, end] of [
                ["added_from", false],
                ["added_before", true],
              ] as const) {
                const value = text(form.get(field));
                if (value) input[field] = addedDayBoundary(value, end);
              }
              if (
                (input.posted_from &&
                  input.posted_to &&
                  text(input.posted_from) > text(input.posted_to)) ||
                (input.added_from &&
                  input.added_before &&
                  Date.parse(text(input.added_from)) >= Date.parse(text(input.added_before)))
              )
                throw new Error("La fecha inicial no puede ser posterior a la final.");
            } catch (error) {
              setFilterError(error instanceof Error ? error.message : "Fechas inválidas.");
              return false;
            }
            setFilterError("");
            setFilters(input);
            const chosen = text(form.get("company_id"));
            if (chosen !== (companyFilter ?? "")) onCompanyChange(chosen || null);
            setSelectedStage(text(input.stage) || "radar");
            return true;
          }}
        >
          <label>
            Etapa
            <select name="stage" defaultValue={text(filters.stage)}>
              <option value="">Todas las etapas</option>
              {stages.map((s) => (
                <option key={s} value={s}>
                  {labels[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Empresa
            <select name="company_id" defaultValue={companyFilter ?? ""}>
              <option value="">Todas las empresas</option>
              {/* One stable option for the active company, so late-loading names keep it selected. */}
              {companyFilter && (
                <option value={companyFilter}>{companyName || `Empresa ${filteredCompany}`}</option>
              )}
              {options(companies.records.filter((c) => c.id !== companyFilter)).map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ubicación
            <input
              defaultValue={text(filters.location_query)}
              name="location_query"
              placeholder="País, ciudad o remoto…"
              maxLength={500}
            />
          </label>
          <label>
            Sueldo
            <select value={salaryKnown} onChange={(e) => setSalaryKnown(e.target.value)}>
              <option value="">Todos</option>
              <option value="known">Con importes numéricos</option>
              <option value="unknown">Sin importes numéricos</option>
            </select>
          </label>
          <fieldset className="salary-filters">
            <legend>Rango de sueldo</legend>
            <div className="salary-fields">
              <label>
                Mínimo
                <input
                  defaultValue={text(filters.salary_min)}
                  name="salary_min"
                  type="number"
                  min="0"
                  step="any"
                  disabled={salaryKnown === "unknown"}
                />
              </label>
              <label>
                Máximo
                <input
                  defaultValue={text(filters.salary_max)}
                  name="salary_max"
                  type="number"
                  min="0"
                  step="any"
                  disabled={salaryKnown === "unknown"}
                />
              </label>
              <label>
                Moneda
                <input
                  defaultValue={text(filters.currency)}
                  name="currency"
                  maxLength={3}
                  pattern="[A-Za-z]{3}"
                  placeholder="USD…"
                  disabled={salaryKnown === "unknown"}
                />
              </label>
            </div>
          </fieldset>
          <fieldset className="date-filters">
            <legend>Fecha de incorporación al CRM</legend>
            <div className="date-fields">
              <label>
                Agregada desde
                <input
                  type="date"
                  name="added_from"
                  defaultValue={localDay(text(filters.added_from))}
                />
              </label>
              <label>
                Agregada hasta
                <input
                  type="date"
                  name="added_before"
                  defaultValue={localDay(text(filters.added_before), true)}
                />
              </label>
            </div>
          </fieldset>
          <fieldset className="date-filters">
            <legend>Fecha de publicación original</legend>
            <div className="date-fields">
              <label>
                Publicada desde
                <input type="date" name="posted_from" defaultValue={text(filters.posted_from)} />
              </label>
              <label>
                Publicada hasta
                <input type="date" name="posted_to" defaultValue={text(filters.posted_to)} />
              </label>
            </div>
          </fieldset>
          <p className="filter-note">
            Las fechas de incorporación usan tu zona horaria. Las vacantes sin fecha de publicación
            quedan fuera de su rango. Los sueldos se comparan en la misma moneda, sin convertir
            divisas.
          </p>
          {filterError && <p role="alert">{filterError}</p>}
        </FilterDialog>
      </div>
      {companyFilter && (
        <div className="active-filters">
          <span>Empresa: {filteredCompany}</span>
          <button
            type="button"
            aria-label={`Quitar filtro de empresa: ${filteredCompany}`}
            onClick={() => {
              onCompanyChange(null);
              // The chip unmounts; keep keyboard focus in the collection tools.
              searchInput.current?.focus();
            }}
          >
            ✕
          </button>
        </div>
      )}
      <details className="collection-filters">
        <summary>Filtros de afinidad Jev</summary>{" "}
        <fieldset className="jev-review-filters">
          <legend>Revisar afinidad con tu CV</legend>
          <label>
            Perfil Jev
            <select
              aria-label="Perfil Jev"
              value={jevProfile}
              onChange={(e) => setJevProfile(e.target.value)}
            >
              <option value="">Todos los perfiles</option>
              {["ai", "general", "backend", "frontend"].flatMap((track) =>
                ["MX", "PE"].map((country) => {
                  const id = `${track}-${country}`;
                  return (
                    <option key={id} value={id}>
                      {profileName(id)}
                    </option>
                  );
                }),
              )}
            </select>
          </label>
          <label>
            Afinidad Jev
            <select
              aria-label="Afinidad Jev"
              value={jevCategory}
              onChange={(e) => setJevCategory(e.target.value)}
            >
              <option value="">Todas las afinidades</option>
              <option value="strong">Fuerte</option>
              <option value="partial">Parcial</option>
              <option value="weak">Débil</option>
              <option value="insufficient_information">Información insuficiente</option>
            </select>
          </label>
          <label>
            Confianza mínima del modelo
            <select
              aria-label="Confianza mínima del modelo"
              value={jevConfidence}
              onChange={(e) => setJevConfidence(Number(e.target.value))}
            >
              {[0, 0.5, 0.7, 0.8, 0.9].map((v) => (
                <option key={v} value={v}>
                  {v ? `${v * 100}%` : "Sin mínimo"}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => {
              setJevProfile("");
              setJevCategory("");
              setJevConfidence(0);
            }}
          >
            Restablecer afinidad
          </button>
          <p className="caption" role="status">
            {visibleJobs.length} coinciden de {jobs.records.length} oportunidades cargadas
            {jobs.hasNextPage ? " · resultados parciales" : ""}. Estos filtros no descartan vacantes
            ni activan investigación.
          </p>
        </fieldset>
      </details>
      {jobs.records.length > 0 && !visibleJobs.length && (
        <p role="status">
          Ninguna oportunidad cargada coincide con los filtros Jev.
          <button
            onClick={() => {
              setJevProfile("");
              setJevCategory("");
              setJevConfidence(0);
            }}
          >
            Limpiar filtros Jev
          </button>
        </p>
      )}
      <div className="pipeline-toolbar">
        <div className="view-controls" role="group" aria-label="Vista del pipeline">
          {(
            [
              ["list", "Lista"],
              ["board", "Tablero"],
              ["table", "Tabla"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              aria-pressed={view === value}
              onClick={() => {
                setView(value);
                if (value === "board" && !jobs.records.some((job) => job.stage === selectedStage))
                  setSelectedStage(text(jobs.records[0]?.stage) || "radar");
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <a className="pipeline-jev-link" href="/?screen=automation">
          Gestionar clasificación Jev
        </a>
        <p role="status" className="pipeline-count">
          {jobs.isPending
            ? "Cargando oportunidades…"
            : `${jobs.records.length} oportunidades${jobs.hasNextPage ? " cargadas · resultados parciales" : ""}`}
        </p>
      </div>
      {!navigator.onLine && (
        <p role="status" className="caption">
          Sin conexión: el orden se aplica a las oportunidades guardadas; puede faltar información
          reciente.
        </p>
      )}
      {jobs.hasNextPage && (
        <p className="caption" role="status">
          {!navigator.onLine
            ? "Sin conexión: se muestran las oportunidades guardadas."
            : jobs.isFetching
              ? "Cargando el resto de las oportunidades…"
              : "Hay oportunidades pendientes de cargar."}
        </p>
      )}
      {view === "board" && (
        <label className="board-stage-select">
          Etapa del tablero
          <select value={selectedStage} onChange={(event) => setSelectedStage(event.target.value)}>
            {stages.map((stage) => (
              <option key={stage} value={stage}>
                {labels[stage]} · {jobs.records.filter((job) => job.stage === stage).length}
                {jobs.hasNextPage ? "+" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <LookupStatus query={companies} label="empresas" />
      <Status query={jobs} empty={!companyFilter} />
      {companyFilter && !jobs.isPending && !jobs.isError && !jobs.records.length && (
        <div className="empty">
          <span aria-hidden="true">◌</span>
          <h3>
            {companyMissing
              ? "Empresa no disponible"
              : Object.keys(filters).length || search.trim()
                ? `Ninguna vacante de ${companyName || "esta empresa"} coincide con los filtros`
                : `${companyName || "Esta empresa"} no tiene vacantes registradas`}
          </h3>
          <p>Quita el filtro de empresa para ver todo el pipeline.</p>
        </div>
      )}
      <div
        className={`pipeline-results pipeline-${view}`}
        role={view === "board" ? "region" : undefined}
        aria-label={view === "board" ? "Tablero por etapas" : undefined}
        tabIndex={view === "board" ? 0 : undefined}
      >
        {stages.map((stage) => {
          const records = (view === "table" ? page.records : visibleJobs).filter(
            (job) => job.stage === stage,
          );
          if (!records.length && view !== "board") return null;
          return (
            <section
              className={`stage-group${view === "board" && selectedStage === stage ? " selected-column" : ""}`}
              key={stage}
              aria-label={`${labels[stage]}${view === "table" ? " en esta página" : ""}`}
            >
              <h2 className="group-heading">
                <Badge value={stage} />{" "}
                <span>
                  {records.length}
                  {view === "table"
                    ? " en esta página"
                    : jobs.hasNextPage
                      ? " cargadas"
                      : " oportunidades"}
                </span>
              </h2>
              {view === "table" ? (
                <div
                  className="table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label={`Tabla ${labels[stage]}`}
                >
                  <table>
                    <caption>
                      {labels[stage]} · página {page.index + 1}
                    </caption>
                    <thead>
                      <tr>
                        <th>Puesto</th>
                        <th>Empresa</th>
                        <th>Ubicación</th>
                        <th>Sueldo</th>
                        <th>Fuente</th>
                        <th>Afinidad con tu CV</th>
                        <th>Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((j) => (
                        <tr key={j.id} {...agent("jobs", j.id, "row")}>
                          <td>{text(j.title)}</td>
                          <td>
                            <CompanyIdentity
                              company={company(j.company_id)}
                              pending={companies.isFetching || companies.hasNextPage}
                            />
                          </td>
                          <td>{text(j.location) || "Por confirmar"}</td>
                          <td>
                            <Salary job={j} />
                          </td>
                          <td>{sourceName(j.source_id)}</td>
                          <td>
                            <JevClassification job={j} fromList />
                          </td>
                          <td>
                            <NavLink
                              className="button"
                              attrs={agent("jobs", j.id, "open")}
                              href={`/?screen=pipeline&job=${j.id}`}
                              go={() => open(j.id)}
                            >
                              Ver detalle
                            </NavLink>
                            <JobPreview job={j} />
                            <ExternalLink href={j.posting_url}>Vacante original</ExternalLink>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="cards">
                  {!records.length && <p className="empty-column">Sin oportunidades</p>}
                  {records.map((j) => (
                    <JobCard
                      key={j.id}
                      job={j}
                      source={sourceName(j.source_id)}
                      company={company(j.company_id)}
                      pending={companies.isFetching || companies.hasNextPage}
                      open={open}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {view === "table" && <CollectionPager page={page} label="oportunidades" />}
    </>
  );
}
function Salary({ job }: { job: RecordData }) {
  const known = typeof job.salary_min === "number" || typeof job.salary_max === "number";
  const numeric = [job.salary_min, job.salary_max]
    .filter((v) => typeof v === "number")
    .map((v) => Number(v).toLocaleString("es-MX"))
    .join("–");
  return (
    <>
      <p className="salary">
        {text(job.salary_text) ||
          (known ? `${numeric} ${text(job.currency)}` : "Sueldo por confirmar")}
      </p>
      {!known && <small>Sin importes numéricos</small>}
    </>
  );
}
function JobCard({
  job,
  company,
  pending,
  source,
  open,
}: {
  job: RecordData;
  company?: RecordData | undefined;
  pending: boolean;
  source: string;
  open: (id: string) => void;
}) {
  const edit = useEdit(job.id);
  return (
    <article className="card record-card" {...agent("jobs", job.id, "card")}>
      <header className="record-header">
        <CompanyIdentity company={company} pending={pending} />
        <Badge value={job.stage} />
      </header>
      <div className="record-body">
        <h3>{text(job.title)}</h3>
        <p>{text(job.location) || "Ubicación por confirmar"}</p>
        <Salary job={job} />
        <JevClassification job={job} fromList />
        <p className="caption">Fuente: {source}</p>
        <p className="caption">
          Agregada al CRM: {displayDate(job.created_at)}
          <br />
          Publicada: {displayDate(job.posted_on)}
        </p>
      </div>
      <div className="record-footer">
        <div className="actions">
          <NavLink
            className="button"
            attrs={agent("jobs", job.id, "open")}
            href={`/?screen=pipeline&job=${job.id}`}
            go={() => open(job.id)}
          >
            Ver oportunidad
          </NavLink>
          <button
            {...agent("jobs", job.id, "mark-viewed")}
            disabled={Boolean(job.viewed || job.viewed_at)}
            onClick={() =>
              edit("jobs.upsert", {
                id: job.id,
                expected_version: job.version,
                viewed: true,
                viewed_at: new Date().toISOString(),
              })
            }
          >
            {job.viewed || job.viewed_at ? "Vista" : "Marcar vista"}
          </button>
        </div>
        <JobPreview job={job} />
        <ExternalLink href={job.posting_url}>Vacante original</ExternalLink>
      </div>
    </article>
  );
}

function JobPreview({ job }: { job: RecordData }) {
  return (
    <Preview title={text(job.title)} entity="jobs" id={job.id}>
      <p className="caption">
        Información guardada en tu CRM. La vacante original puede haber cambiado.
      </p>
      <p>{text(job.location) || "Ubicación por confirmar"}</p>
      <Salary job={job} />
      <JevClassification job={job} fromList />
      <h3>Descripción guardada</h3>
      <p className="message-body">
        {text(job.description_summary) ||
          "Todavía no hay una descripción guardada para esta oportunidad."}
      </p>
      <ExternalLink href={job.posting_url}>Abrir vacante original</ExternalLink>
    </Preview>
  );
}

export function addedDayBoundary(day: string, inclusiveEnd = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Fecha inválida.");
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const value = new Date(year, month - 1, date);
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== date)
    throw new Error("Fecha inválida.");
  if (inclusiveEnd) value.setDate(value.getDate() + 1);
  return value.toISOString();
}
function localDay(value: string, end = false) {
  if (!value) return "";
  const date = new Date(value);
  if (end) date.setDate(date.getDate() - 1);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
function displayDate(value: unknown) {
  const raw = text(value);
  if (!raw) return "Sin fecha";
  return new Date(raw.length === 10 ? raw + "T12:00:00" : raw).toLocaleDateString("es-MX");
}
