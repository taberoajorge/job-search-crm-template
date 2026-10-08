import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RecordData } from "../api/client";
import type { useRecords } from "../state/crm";
import { text } from "../state/model";

type Collection = Pick<ReturnType<typeof useRecords>, "records" | "hasNextPage" | "isFetching"> & {
  fetchNextPage: () => Promise<{ isError: boolean }>;
};
export function FilterDialog({
  count,
  children,
  onApply,
  onClear,
  onOpen,
}: {
  count: number;
  children: ReactNode;
  onApply: (data: FormData) => boolean | void;
  onClear: () => void;
  onOpen?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        aria-haspopup="dialog"
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
      >
        Filtros · {count}
      </button>
      <dialog
        ref={dialog}
        className="filter-dialog"
        aria-label="Filtros"
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
      >
        <div className="dialog-head">
          <h2>Filtros</h2>
          <button type="button" aria-label="Cerrar filtros" onClick={() => dialog.current?.close()}>
            ×
          </button>
        </div>
        {open && (
          <form
            className="filter-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (onApply(new FormData(event.currentTarget)) !== false) dialog.current?.close();
            }}
          >
            <div className="filter-fields">{children}</div>
            <div className="actions filter-actions">
              <button type="submit" className="primary">
                Aplicar filtros
              </button>
              <button
                type="button"
                onClick={() => {
                  onClear();
                  dialog.current?.close();
                }}
              >
                Limpiar filtros
              </button>
              <button type="button" onClick={() => dialog.current?.close()}>
                Cancelar
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
export function useCollectionPage(query: Collection, scope = "", pageSize: 6 | 12 = 12) {
  const [position, setPosition] = useState({ scope, index: 0 });
  if (position.scope !== scope) setPosition({ scope, index: 0 });
  const index = Math.min(
    position.scope === scope ? position.index : 0,
    Math.max(0, Math.ceil(query.records.length / pageSize) - 1),
  );
  const end = Math.min((index + 1) * pageSize, query.records.length);
  return {
    records: query.records.slice(index * pageSize, end),
    start: query.records.length ? index * pageSize + 1 : 0,
    end,
    loaded: query.records.length,
    more: Boolean(query.hasNextPage),
    index,
    busy: query.isFetching,
    hasNext: end < query.records.length || (Boolean(query.hasNextPage) && navigator.onLine),
    previous: () => setPosition({ scope, index: Math.max(0, index - 1) }),
    next: async () => {
      if (query.hasNextPage && end < (index + 1) * pageSize) {
        // An offline page may contain the last few cached rows. Fill that same page on reconnect.
        if (navigator.onLine) await query.fetchNextPage();
        return;
      }
      // Fill the next visible page before moving; 50-record API pages do not divide by page size.
      if ((index + 2) * pageSize > query.records.length && query.hasNextPage && navigator.onLine) {
        const result = await query.fetchNextPage();
        if (result.isError) return;
      }
      setPosition({ scope, index: index + 1 });
    },
  };
}
export function CollectionPager({
  page,
  label,
}: {
  page: ReturnType<typeof useCollectionPage>;
  label: string;
}) {
  return (
    <nav className="collection-pager" aria-label={`Paginación de ${label}`}>
      <p role="status">
        {page.start}–{page.end} de {page.loaded} {page.more ? "cargados · hay más" : label}
      </p>
      <div className="pager-actions">
        <button
          disabled={page.index === 0 || page.busy}
          onClick={page.previous}
          aria-label={`Página anterior de ${label}`}
        >
          Anterior
        </button>
        {/* aria-label is ignored on a generic span; visible text names the page for everyone. */}
        <span aria-current="page">Página {page.index + 1}</span>
        <button
          disabled={!page.hasNext || page.busy}
          onClick={() => void page.next()}
          aria-label={`Página siguiente de ${label}`}
        >
          {page.busy ? "Cargando…" : "Siguiente"}
        </button>
      </div>
    </nav>
  );
}
export function CollectionFilters({
  children,
  label = "Filtros",
  expandAt,
}: {
  children: ReactNode;
  label?: string;
  expandAt?: number;
}) {
  const [open, setOpen] = useState(
    () =>
      expandAt !== undefined &&
      typeof matchMedia === "function" &&
      matchMedia(`(min-width: ${expandAt}px)`).matches,
  );
  useEffect(() => {
    if (expandAt === undefined || typeof matchMedia !== "function") return;
    const media = matchMedia(`(min-width: ${expandAt}px)`);
    const update = () => setOpen(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [expandAt]);
  return (
    <details
      className={`collection-filters${expandAt !== undefined ? " responsive-form" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{label}</summary>
      <div className="filters">{children}</div>
    </details>
  );
}
export function LookupStatus({
  query,
  label,
}: {
  query: Pick<ReturnType<typeof useRecords>, "isError" | "isFetching" | "hasNextPage" | "refetch">;
  label: string;
}) {
  if (query.isError)
    return (
      <p role="alert">
        No se completó el catálogo de {label}.{" "}
        <button onClick={() => void query.refetch()}>Reintentar {label}</button>
      </p>
    );
  return query.isFetching || query.hasNextPage ? (
    <p className="caption" role="status">
      {query.isFetching
        ? `Cargando catálogo de ${label}…`
        : `Catálogo de ${label} incompleto${navigator.onLine ? "." : " sin conexión."}`}
    </p>
  ) : null;
}
export function companyWebsite(company?: RecordData) {
  try {
    const url = new URL(text(company?.website_url));
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}
export function CompanyIdentity({
  company,
  pending = false,
}: {
  company?: RecordData | undefined;
  pending?: boolean;
}) {
  const website = companyWebsite(company);
  const name = text(company?.name) || (pending ? "Empresa por cargar" : "Empresa sin identificar");
  return (
    <div className="company-identity">
      <span className="company-icon" aria-hidden="true">
        {name.slice(0, 1)}
        {website && (
          <img
            key={website.origin}
            src={`${website.origin}/favicon.ico`}
            width="32"
            height="32"
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        )}
      </span>
      {website ? (
        <a href={website.href} target="_blank" rel="noopener noreferrer">
          {name}
        </a>
      ) : (
        <span>{name}</span>
      )}
    </div>
  );
}
