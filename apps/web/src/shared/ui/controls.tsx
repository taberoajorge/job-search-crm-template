import { parseOperation } from "@crm/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { OperationError, type RecordData } from "../api/client";
import { useEdit, useNotice } from "../state/crm";
import { useRetained } from "../state/recovery";
import { interviewInstant, zonedLocal } from "./interview-time";
import { labels, text } from "../state/model";
export function agent(entity: string, id: string, action: string) {
  return { "data-agent-entity": entity, "data-agent-id": id, "data-agent-action": action };
}
export type Field = {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  options?: { value: string; label: string; group?: string }[];
  multiple?: boolean;
  dependsOn?: string;
  maxLength?: number;
  max?: number | string;
};
export function Editor({
  entity,
  operation,
  record,
  title,
  fields,
  initial = {},
  children,
  inline = false,
  disabled = false,
  onSubmitted,
}: {
  entity: string;
  operation: string;
  record?: RecordData;
  title: string;
  fields: Field[];
  initial?: Record<string, unknown>;
  children?: ReactNode;
  inline?: boolean;
  disabled?: boolean;
  onSubmitted?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [id] = useState(() => record?.id || crypto.randomUUID());
  const [snapshot, setSnapshot] = useState({ record, revision: 0 });
  const retained = useRetained<{
    record: RecordData | undefined;
    values: Record<string, unknown>;
    id: string;
  }>(`form:${entity}:${record?.id || "new"}:${operation}:${title}`);
  const baseline = retained.value?.record ?? snapshot.record;
  const [occurrence, setOccurrence] = useState("");
  const edit = useEdit(retained.value?.id ?? id);
  const [error, setError] = useState({ field: "", message: "" });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const form = (
    <form
      key={`${snapshot.revision}:${retained.ready}`}
      aria-label={title}
      onChange={(event) => {
        setDirty(true);
        const data = new FormData(event.currentTarget);
        const values = Object.fromEntries(
          fields.map((field) => [
            field.name,
            field.multiple ? data.getAll(field.name) : data.get(field.name),
          ]),
        );
        const changed = event.target as HTMLInputElement | HTMLSelectElement;
        for (const field of fields)
          if (field.multiple && field.dependsOn === changed.name)
            values[field.name] = data
              .getAll(field.name)
              .filter((value) =>
                field.options?.some(
                  (option) => option.value === value && option.group === changed.value,
                ),
              );
        retained.set({ record: baseline, id: retained.value?.id ?? id, values });
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const values = Object.fromEntries(
          fields.map((field) => {
            const raw = text(form.get(field.name));
            let value: unknown = raw;
            if (field.name === "currency") value = raw ? raw.toUpperCase() : null;
            if (field.type === "number") value = raw ? Number(raw) : null;
            if (field.type === "datetime-local")
              value = raw
                ? field.name === "scheduled_at"
                  ? raw
                  : new Date(raw).toISOString()
                : null;
            if (field.multiple) value = form.getAll(field.name).map(text);
            else if (field.name === "interviewer_ids")
              value = raw
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean);
            if ((field.type === "url" || field.type === "email") && !raw) value = null;
            if (field.options && !field.multiple && !raw && !field.required) value = null;
            return [field.name, value];
          }),
        );
        if (operation === "outreach.draft")
          for (const key of ["contact_id", "job_id", "resume_id"])
            if (!values[key]) delete values[key];
        if (operation === "jobs.transition" && !values.applied_at) delete values.applied_at;
        // jobs_money_currency rejects a salary without an ISO currency, but without naming the field.
        if (
          "currency" in values &&
          (values.salary_min != null || values.salary_max != null) &&
          !/^[A-Z]{3}$/.test(text(values.currency))
        ) {
          setError({
            field: "currency",
            message: "Indica la moneda ISO de tres letras (MXN, USD, EUR) del salario.",
          });
          const control = event.currentTarget.elements.namedItem("currency");
          if (control instanceof HTMLElement) control.focus();
          return;
        }
        if (values.scheduled_at) {
          try {
            values.scheduled_at = interviewInstant(
              String(values.scheduled_at),
              String(values.timezone),
              occurrence,
            );
          } catch (failure) {
            // Intl throws an English RangeError for an unknown zone; name the field in Spanish.
            const message =
              failure instanceof RangeError
                ? "Zona horaria IANA inválida (por ejemplo, America/Mexico_City)."
                : failure instanceof Error
                  ? failure.message
                  : "Revisa fecha y zona.";
            setError({
              field: failure instanceof RangeError ? "timezone" : "scheduled_at",
              message,
            });
            return;
          }
        }
        const input = {
          ...initial,
          ...values,
          ...(baseline ? { id: baseline.id, expected_version: baseline.version } : {}),
        };
        try {
          parseOperation(operation, { ...input, idempotency_key: crypto.randomUUID() });
          setError({ field: "", message: "" });
        } catch (failure) {
          const issue = (failure as { issues?: { path: PropertyKey[]; message: string }[] })
            .issues?.[0];
          const field = String(issue?.path[0] || "");
          setError({ field, message: issue?.message || "Revisa los campos del formulario." });
          const control = event.currentTarget.elements.namedItem(field);
          if (control instanceof HTMLElement) control.focus();
          return;
        }
        // One save per intent: a second click before the first is queued would mint another key.
        if (busy.current) return;
        busy.current = true;
        setSaving(true);
        const saved = await edit(operation, {
          ...initial,
          ...values,
          ...(baseline ? { id: baseline.id, expected_version: baseline.version } : {}),
        }).finally(() => {
          busy.current = false;
          setSaving(false);
        });
        if (saved) {
          retained.set(null);
          setDirty(false);
          setOccurrence("");
          ref.current?.close();
          onSubmitted?.();
        }
      }}
    >
      {fields.map((field) => {
        const original =
          retained.value?.values[field.name] ?? baseline?.[field.name] ?? initial[field.name];
        const stored = field.type === "datetime-local" ? instant(original) : "";
        const value = stored
          ? field.name === "scheduled_at"
            ? zonedLocal(
                stored,
                text(retained.value?.values.timezone ?? baseline?.timezone ?? initial.timezone) ||
                  Intl.DateTimeFormat().resolvedOptions().timeZone,
              )
            : localDate(stored)
          : Array.isArray(original)
            ? original.join(", ")
            : text(original);
        const dependency = field.dependsOn
          ? (selection[field.dependsOn] ??
            text(
              retained.value?.values[field.dependsOn] ??
                baseline?.[field.dependsOn] ??
                initial[field.dependsOn],
            ))
          : undefined;
        const available = field.options?.filter(
          (option) => dependency === undefined || option.group === dependency,
        );
        if (
          field.options &&
          !field.multiple &&
          value &&
          !available?.some((option) => option.value === value) &&
          selection[field.dependsOn ?? ""] === undefined
        )
          available?.push({ value, label: "Referencia registrada (datos no disponibles)" });
        if (
          field.multiple &&
          Array.isArray(original) &&
          selection[field.dependsOn ?? ""] === undefined
        )
          for (const recorded of original)
            if (!available?.some((o) => o.value === recorded))
              available?.push({
                value: String(recorded),
                label: "Participante registrado sin datos disponibles",
              });
        const errorProps = {
          "aria-invalid": error.field === field.name || undefined,
          "aria-describedby": error.field === field.name ? `${id}-error` : undefined,
        };
        return (
          <label key={field.name}>
            {field.label}
            {field.options ? (
              <select
                {...errorProps}
                key={dependency}
                name={field.name}
                multiple={field.multiple}
                defaultValue={
                  field.multiple
                    ? selection[field.dependsOn ?? ""] !== undefined
                      ? []
                      : Array.isArray(original)
                        ? original
                        : []
                    : value
                }
                onChange={(event) => {
                  if (!field.multiple)
                    setSelection((current) => ({ ...current, [field.name]: event.target.value }));
                }}
                required={field.required}
              >
                {!field.required && !field.multiple && <option value="">Sin asignar</option>}
                {field.required && !value && <option value="">Selecciona…</option>}
                {available?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === "textarea" ? (
              <textarea
                {...errorProps}
                name={field.name}
                defaultValue={value}
                required={field.required}
                maxLength={field.maxLength}
                rows={4}
              />
            ) : (
              <input
                {...errorProps}
                name={field.name}
                type={field.type || "text"}
                defaultValue={value}
                required={field.required}
                maxLength={field.maxLength}
                max={field.max}
                min={field.type === "number" ? 0 : undefined}
                step={field.type === "number" ? "any" : undefined}
              />
            )}
          </label>
        );
      })}
      {fields.some((f) => f.name === "scheduled_at") && (
        <label>
          Si la hora se repite por cambio horario
          <select value={occurrence} onChange={(e) => setOccurrence(e.target.value)}>
            <option value="">Seleccionar cuando corresponda</option>
            <option value="first">Primera ocurrencia</option>
            <option value="second">Segunda ocurrencia</option>
          </select>
        </label>
      )}
      {retained.error && (
        <p role="alert">
          {retained.error}
          <button type="button" onClick={() => void retained.retry()}>
            Reintentar almacenamiento
          </button>
        </p>
      )}
      {error.message && (
        <p id={`${id}-error`} role="alert">
          {error.message}
        </p>
      )}
      {children}
      <div className="actions">
        <button className="primary" type="submit" disabled={saving}>
          Guardar
        </button>
        {!inline && (
          <button
            type="button"
            onClick={() => {
              retained.set(null);
              setDirty(false);
              setOccurrence("");
              setSnapshot((current) => ({ record, revision: current.revision + 1 }));
              ref.current?.close();
            }}
          >
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
  if (inline)
    return (
      <section className="card inline-editor">
        <h2>{title}</h2>
        {form}
      </section>
    );
  return (
    <>
      <button
        {...agent(entity, id, record ? "edit" : "create")}
        className={record ? "" : "primary"}
        disabled={disabled}
        onClick={() => {
          if (!dirty && !retained.value) {
            setSnapshot((current) => ({ record, revision: current.revision + 1 }));
            setSelection({});
            setOccurrence("");
          }
          setError({ field: "", message: "" });
          ref.current?.showModal();
        }}
      >
        {title}
      </button>
      <dialog ref={ref} aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" aria-label="Cerrar formulario" onClick={() => ref.current?.close()}>
            ×
          </button>
        </div>
        {form}
      </dialog>
    </>
  );
}
// Stored instants carry Z or a numeric offset (Postgres to_jsonb emits "+00:00" and microseconds);
// local drafts carry neither. Fractions are cut to milliseconds so every engine parses them.
function instant(value: unknown) {
  const match = /^(.+T\d{2}:\d{2}(?::\d{2})?)(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.exec(text(value));
  return match ? `${match[1]}${(match[2] ?? "").slice(0, 4)}${match[3]}` : "";
}
// datetime-local value for "now", used as max for fields that record what already happened.
export function nowLocal() {
  return localDate(new Date().toISOString());
}
function localDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ""
    : new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function options(records: RecordData[], name = "name") {
  // A record created offline has a client-only id until it syncs; referencing it would fail on replay.
  return records
    .filter((r) => !r.pending_local)
    .map((r) => ({ value: r.id, label: text(r[name]) }));
}
export function enumOptions(values: readonly string[]) {
  return values.map((value) => ({ value, label: labels[value] || value }));
}
export function Status({
  query,
  empty = true,
}: {
  /** false when the screen supplies its own empty copy. */
  empty?: boolean;
  query: {
    isPending: boolean;
    isError: boolean;
    error: Error | null;
    records?: RecordData[] | undefined;
    refetch: () => unknown;
    dataUpdatedAt?: number;
    isFetching?: boolean;
    hasNextPage?: boolean;
    fetchNextPage?: () => unknown;
  };
}) {
  return (
    <>
      {query.isPending && (
        <p role="status">
          {navigator.onLine ? "Cargando…" : "Sin conexión. No hay datos guardados para esta vista."}
        </p>
      )}
      {query.isError && (
        <div role="alert">
          <p>{query.error?.message || "No se pudo cargar."}</p>
          {query.dataUpdatedAt ? (
            <p>
              Datos guardados observados: {new Date(query.dataUpdatedAt).toLocaleString("es-MX")}.
              La actualización falló.
            </p>
          ) : null}
          {query.error instanceof OperationError && query.error.retryable === false && (
            <p>Esta respuesta requiere revisar los datos o permisos antes de continuar.</p>
          )}
          <button onClick={() => void query.refetch()}>Reintentar</button>
        </div>
      )}
      {empty && !query.isPending && !query.isError && query.records?.length === 0 && (
        <div className="empty">
          <span aria-hidden="true">◌</span>
          <h3>Sin registros</h3>
          <p>Agrega un registro para verlo en esta vista.</p>
        </div>
      )}
    </>
  );
}
export function Copy({ value, id }: { value: string; id: string }) {
  const notice = useNotice();
  const [failed, setFailed] = useState(false);
  return (
    <>
      <button
        {...agent("outreach", id, "copy")}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            notice("Texto copiado.", "success");
            setFailed(false);
          } catch {
            setFailed(true);
            notice("No se pudo copiar. Selecciona el texto manualmente.");
          }
        }}
      >
        Copiar texto
      </button>
      {failed && (
        <label>
          Copia manual
          <textarea readOnly value={value} onFocus={(event) => event.target.select()} />
        </label>
      )}
    </>
  );
}
export function Badge({ value }: { value: unknown }) {
  return <span className={`badge ${text(value)}`}>{labels[text(value)] || text(value)}</span>;
}
export function safeExternalUrl(value: unknown) {
  try {
    const url = new URL(text(value));
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
// Navigation is a link with a real destination; a plain left click stays inside the app.
export function NavLink({
  href,
  go,
  className = "",
  attrs,
  children,
}: {
  href: string;
  go: () => void;
  /** "button" styles the link like a secondary button; "button primary" like the primary one. */
  className?: string;
  attrs?: Record<string, string>;
  children: ReactNode;
}) {
  return (
    <a
      {...attrs}
      href={href}
      className={className.replace(/\bbutton\b/, "nav-link") || undefined}
      onClick={(event) => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        go();
      }}
    >
      {children}
    </a>
  );
}
export function ExternalLink({ href, children }: { href: unknown; children: ReactNode }) {
  const url = text(href);
  return safeExternalUrl(url) ? (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {children} ↗
    </a>
  ) : null;
}

export function Preview({
  title,
  children,
  entity = "preview",
  id = "",
  trigger = "Vista previa",
  keepMounted = false,
  className,
}: {
  title: string;
  children: ReactNode;
  entity?: string;
  id?: string;
  trigger?: string;
  keepMounted?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) ref.current?.showModal();
  }, [open]);
  return (
    <>
      <button
        {...agent(entity, id, "preview")}
        aria-label={trigger === "Vista previa" ? `${trigger}: ${title}` : trigger}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">◉</span> {trigger}
      </button>
      <dialog
        ref={ref}
        className={className}
        aria-label={title}
        onClose={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
          <button aria-label="Cerrar vista previa" onClick={() => ref.current?.close()}>
            ×
          </button>
        </div>
        {(open || keepMounted) && children}
      </dialog>
    </>
  );
}
export function ContactProfile({ record }: { record: RecordData }) {
  return (
    <>
      <h3>{text(record.name)}</h3>
      <p>{text(record.role) || "Cargo sin registrar"}</p>
      {Boolean(record.email) && <p>{text(record.email)}</p>}
      <p>Información guardada en tu CRM. Abre el perfil para consultar su contenido actualizado.</p>
      <ExternalLink href={record.linkedin_url}>Abrir perfil de LinkedIn</ExternalLink>
    </>
  );
}

export function DetailTabs({
  id,
  items,
  value,
  onChange,
}: {
  id: string;
  items: string[][];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="detail-tabs" role="tablist" aria-label="Secciones">
      {items.map(([key, label], index) => (
        <button
          key={key}
          type="button"
          role="tab"
          id={`${id}-${key}-tab`}
          aria-controls={`${id}-${key}-panel`}
          aria-selected={value === key}
          tabIndex={value === key ? 0 : -1}
          onClick={() => onChange(key!)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % items.length
                : event.key === "ArrowLeft"
                  ? (index + items.length - 1) % items.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : null;
            if (next === null) return;
            event.preventDefault();
            onChange(items[next]![0]!);
            (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
