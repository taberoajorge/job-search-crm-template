import { ContactErasure } from "../shared/ui/contact-erasure";
import { ResourceTable } from "../shared/ui/resource-table";
import { useEffect, useState } from "react";
import { useLookupRecords, useRecords } from "../shared/state/crm";
import { labels, statuses, text } from "../shared/state/model";
import type { RecordData } from "../shared/api/client";
import {
  Badge,
  Copy,
  Preview,
  ContactProfile,
  Editor,
  enumOptions,
  ExternalLink,
  NavLink,
  nowLocal,
  safeExternalUrl,
  options,
  Status,
  type Field,
} from "../shared/ui/controls";
import {
  FilterDialog,
  CollectionPager,
  CompanyIdentity,
  LookupStatus,
  useCollectionPage,
} from "../shared/ui/collections";
type Navigate = (screen: string, job?: string, section?: string, company?: string) => void;
/** The confirmed vacancy and the company's pipeline stay two separately labeled destinations. */
function VacancyLinks({
  contact,
  companyName,
  navigate,
}: {
  contact: RecordData;
  companyName: string;
  navigate: Navigate;
}) {
  const job = text(contact.job_id);
  const company = text(contact.company_id);
  return (
    <div className="contact-links">
      {job && (
        <NavLink
          className="button"
          href={`/?screen=pipeline&job=${job}&section=people`}
          go={() => navigate("pipeline", job, "people")}
        >
          Ver vacante vinculada
        </NavLink>
      )}
      {company && (
        <NavLink
          className="button"
          href={`/?screen=pipeline&company=${company}`}
          go={() => navigate("pipeline", undefined, undefined, company)}
        >
          Ver vacantes de {companyName}
        </NavLink>
      )}
    </div>
  );
}
export function Contacts({ navigate }: { navigate: Navigate }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  // Query the server once typing pauses, not on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const [status, setStatus] = useState("");
  const contacts = useRecords("contacts.search", {
    ...(query ? { query } : {}),
    ...(status ? { status } : {}),
  });
  const companies = useLookupRecords("companies.list");
  const jobs = useLookupRecords("jobs.list");
  const page = useCollectionPage(contacts, JSON.stringify({ query, status }));
  const jobsLoading = !jobs.isError && (jobs.isPending || jobs.isFetching || jobs.hasNextPage);
  // Only the recorded job_id is this contact's vacancy; never infer one from the company.
  const vacancy = (c: RecordData) => {
    if (!c.job_id) return "Sin vacante confirmada";
    const job = jobs.records.find((j) => j.id === c.job_id);
    if (!job) return jobsLoading ? "Consultando vacante…" : "Vacante no disponible";
    return `${text(job.title)}${job.stage === "archived" ? ` · ${labels.archived}` : ""}`;
  };
  const companyName = (c: RecordData) =>
    text(companies.records.find((company) => company.id === c.company_id)?.name) || "la empresa";
  const fields: Field[] = [
    {
      name: "company_id",
      label: "Empresa del contacto",
      required: true,
      options: options(companies.records),
    },
    {
      name: "job_id",
      label: "Vacante vinculada (solo si está confirmada)",
      options: options(jobs.records, "title"),
    },
    { name: "name", label: "Nombre", required: true },
    { name: "role", label: "Cargo" },
    { name: "email", label: "Correo", type: "email" },
    { name: "linkedin_url", label: "LinkedIn", type: "url" },
    { name: "status", label: "Estado", required: true, options: enumOptions(statuses) },
    {
      name: "invite_at",
      label: "Invitación enviada realmente el",
      type: "datetime-local",
      max: nowLocal(),
    },
    {
      name: "last_interacted_at",
      label: "Última interacción real",
      type: "datetime-local",
      max: nowLocal(),
    },
    {
      name: "draft_note",
      label: "Nota de invitación (máximo 300 caracteres)",
      type: "textarea",
      maxLength: 300,
    },
    { name: "draft_message", label: "Borrador de mensaje", type: "textarea" },
    { name: "notes", label: "Notas", type: "textarea" },
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Contactos</h1>
        </div>
        <Editor
          entity="contacts"
          operation="contacts.upsert"
          title="Agregar contacto"
          fields={fields}
          initial={{ status: "uncontacted" }}
        />
      </div>
      <div className="collection-toolbar">
        <label className="collection-search">
          Buscar contactos
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nombre, empresa o cargo…"
          />
        </label>
        <FilterDialog
          count={status ? 1 : 0}
          onClear={() => setStatus("")}
          onApply={(data) => setStatus(text(data.get("status")))}
        >
          <label>
            Estado
            <select name="status" defaultValue={status}>
              <option value="">Todos</option>
              {enumOptions(statuses).map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </FilterDialog>
      </div>
      <LookupStatus query={companies} label="empresas" />
      <LookupStatus query={jobs} label="vacantes" />
      <Status query={contacts} />
      <ResourceTable
        responsive
        rows={page.records}
        entity="contacts"
        label="Contactos en esta página"
        columns={[
          {
            key: "name",
            label: "Persona",
            render: (c) => (
              <>
                <strong>
                  {safeExternalUrl(c.linkedin_url) ? (
                    <ExternalLink href={c.linkedin_url}>{text(c.name)}</ExternalLink>
                  ) : (
                    text(c.name)
                  )}
                </strong>
                <p>{text(c.role) || "Cargo sin registrar"}</p>
              </>
            ),
          },
          {
            key: "company",
            label: "Empresa",
            render: (c) => (
              <>
                <CompanyIdentity
                  company={companies.records.find((company) => company.id === c.company_id)}
                  pending={companies.isFetching || companies.hasNextPage}
                />
                <p className="contact-vacancy">Vacante: {vacancy(c)}</p>
              </>
            ),
          },
          { key: "email", label: "Correo", render: (c) => text(c.email) || "Correo no registrado" },
          {
            key: "status",
            label: "Estado",
            render: (c) => (
              <>
                <Badge value={c.status} />
                {!!c.archived_at && <span className="badge archived">Archivado</span>}
              </>
            ),
          },
        ]}
        actions={(c) => (
          <>
            <Preview title={`Perfil de ${text(c.name)}`} entity="contacts" id={c.id}>
              <ContactProfile record={c} />
              <p>Vacante vinculada: {vacancy(c)}</p>
              <VacancyLinks contact={c} companyName={companyName(c)} navigate={navigate} />
              <ContactErasure id={c.id} />
              <details>
                <summary>Borradores</summary>
                <h3>Nota de invitación</h3>
                {text(c.draft_note) ? (
                  <>
                    <p className="preserve-text">{text(c.draft_note)}</p>
                    <Copy value={text(c.draft_note)} id={`${c.id}-note`} />
                  </>
                ) : (
                  <p>Sin nota de invitación.</p>
                )}
                <h3>Mensaje</h3>
                {text(c.draft_message) ? (
                  <>
                    <p className="preserve-text">{text(c.draft_message)}</p>
                    <Copy value={text(c.draft_message)} id={`${c.id}-message`} />
                  </>
                ) : (
                  <p>Sin mensaje preparado.</p>
                )}
              </details>
            </Preview>
            <Editor
              entity="contacts"
              operation="contacts.upsert"
              record={c}
              title="Editar contacto"
              fields={fields}
            />
          </>
        )}
      />
      <CollectionPager page={page} label="contactos" />
    </>
  );
}
