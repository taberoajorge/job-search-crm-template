import { useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  notificationOutputs,
  notificationLink,
  notificationLabels,
  type NotificationList,
  type NotificationDetail,
  type NotificationState,
} from "@crm/contracts";
import { CollectionPager, useCollectionPage } from "../ui/collections";
import { useRetained } from "../state/recovery";
import { ExternalLink } from "../ui/controls";
import { operation } from "../api/client";
import { useExactWrite, useRead } from "../state/crm";

function date(value: string) {
  return new Date(value).toLocaleString("es-MX");
}
// Keep the exact intent available after an ambiguous network response.
function useNotificationWrite() {
  const client = useQueryClient();
  const write = useExactWrite("notifications");
  return {
    ...write,
    review: () =>
      client.invalidateQueries({
        predicate: (q) => String(q.queryKey[0]).startsWith("notifications"),
      }),
  };
}
export function Notifications() {
  const [unread, setUnread] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ["notifications.list", { unread }],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      notificationOutputs["notifications.list"].parse(
        await operation("notifications.list", {
          unread,
          limit: 12,
          ...(pageParam ? { cursor: pageParam } : {}),
        }),
      ),
    getNextPageParam: (page: NotificationList) => page.next_cursor ?? undefined,
    refetchOnReconnect: true,
    refetchInterval: 30000,
  });
  const write = useNotificationWrite();
  const page = useCollectionPage(
    { ...query, records: (query.data?.pages.flatMap((p) => p.items) || []) as any },
    String(unread),
  );
  const first = query.data?.pages[0];
  const selected = new URLSearchParams(location.search).get("notification");
  return (
    <section className="screen notification-center">
      <div className="page-heading">
        <h1>Notificaciones</h1>
        <a href="/?screen=settings&section=notifications">Ajustar avisos</a>
      </div>
      <p>
        Cambios guardados de la automatización. Las investigaciones pendientes no se muestran como
        terminadas.
      </p>
      <label>
        <input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} />{" "}
        Solo no leídas
      </label>
      {first && (
        <button
          disabled={write.pending || !!write.intent || !navigator.onLine || !first.unread_count}
          onClick={() =>
            void write.write("notifications.mark_all", {
              expected_version: first.state_version,
              cutoff: first.cutoff,
            })
          }
        >
          Marcar leídas hasta este momento
        </button>
      )}
      {query.isPending && <p role="status">Cargando notificaciones…</p>}
      {query.isError && (
        <p role="alert">
          No se pudo actualizar el historial. Los datos visibles pueden estar desactualizados.{" "}
          <button onClick={() => void query.refetch()}>Reintentar consulta</button>
        </p>
      )}
      {!navigator.onLine && (
        <p role="status">Sin conexión: historial guardado, posiblemente desactualizado.</p>
      )}
      {query.dataUpdatedAt > 0 && (
        <p className="caption">
          Observado: {new Date(query.dataUpdatedAt).toLocaleString("es-MX")}
        </p>
      )}
      <WriteStatus write={write} />
      {selected && <NotificationChanges id={selected} />}
      {(page.records as NotificationList["items"]).map((batch, index, batches) => (
        <div key={batch.id}>
          {(index === 0 ||
            new Date(batch.window_start).toLocaleDateString("es-MX") !==
              new Date(batches[index - 1]!.window_start).toLocaleDateString("es-MX")) && (
            <h2 className="notification-date">
              {new Date(batch.window_start).toLocaleDateString("es-MX", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </h2>
          )}
          <article className={`notification-row${batch.read_at ? "" : " unread"}`}>
            <h3>
              {batch.vacancies === 1
                ? "Una vacante actualizada"
                : `${batch.vacancies} vacantes actualizadas`}
            </h3>
            <p className="caption">
              {date(batch.window_start)} — {date(batch.window_end)} ·{" "}
              {batch.read_at ? "Leída" : "No leída"}
              {batch.open ? " · Lote aún abierto" : ""}
            </p>
            <details className="notification-delivery">
              <summary>Estado del correo</summary>
              <p>
                Último correo vinculado:{" "}
                {
                  {
                    not_queued: "No encolado",
                    queued: "Pendiente",
                    accepted: "Aceptado por proveedor; entrega sin verificar",
                    failed: "Falló",
                    cancelled: "Cancelado",
                  }[batch.delivery]
                }
              </p>
            </details>
            <button
              disabled={write.pending || !!write.intent || !navigator.onLine}
              onClick={() =>
                void write.write("notifications.read", {
                  id: batch.id,
                  expected_version: batch.version,
                  read: !batch.read_at,
                })
              }
            >
              {batch.read_at ? "Marcar no leída" : "Marcar leída"}
            </button>
            <LazyBatch id={batch.id} />
          </article>
        </div>
      ))}
      {first && !first.items.length && <p>No hay notificaciones en este filtro.</p>}
      <CollectionPager page={page} label="notificaciones" />
    </section>
  );
}
function WriteStatus({ write }: { write: ReturnType<typeof useNotificationWrite> }) {
  // The retained intent outlives this component's error state (reload, navigation): keep recovery visible.
  return write.error || (write.intent && !write.pending) ? (
    <div role="alert">
      <p>{write.error || "Hay un cambio sin confirmar"}. La solicitud original se conserva.</p>
      <button disabled={write.pending} onClick={() => void write.retry()}>
        Reintentar el mismo cambio
      </button>
      {write.confirmedRejected && (
        <button disabled={write.pending} onClick={() => void write.discardRejected()}>
          Descartar solicitud rechazada; conservar borrador
        </button>
      )}
      <button disabled={write.pending} onClick={() => void write.review()}>
        Consultar estado y revisar
      </button>
    </div>
  ) : null;
}
const fields: Record<string, string> = {
  title: "Puesto",
  location: "Ubicación",
  salary_text: "Salario",
  salary_min: "Salario mínimo",
  salary_max: "Salario máximo",
  currency: "Moneda",
  posting_url: "Publicación",
  stage: "Etapa",
  reason: "Motivo",
  evidence_url: "Evidencia",
  description_updated: "Descripción actualizada",
  verified_contacts_added: "Contactos verificados añadidos",
  company_information_updated: "Empresa actualizada",
  preparation_version: "Versión de preparación",
  review_gaps: "Puntos que requieren revisión",
  contact_information_updated: "Información de contacto actualizada",
};
export function NotificationChanges({ id, jobId }: { id: string; jobId?: string }) {
  const query = useInfiniteQuery({
    queryKey: ["notifications.get", { id, jobId }],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      notificationOutputs["notifications.get"].parse(
        await operation("notifications.get", {
          id,
          limit: 20,
          ...(jobId ? { job_id: jobId } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        }),
      ),
    getNextPageParam: (p: NotificationDetail) => p.next_cursor ?? undefined,
    refetchInterval: 30000,
  });
  return (
    <div className="notification-changes">
      {query.isPending && <p role="status">Cargando cambios…</p>}
      {query.isError && (
        <p role="alert">
          Cambios no disponibles. La vacante puede no pertenecer a este lote.{" "}
          <button onClick={() => void query.refetch()}>Reintentar</button>
        </p>
      )}
      {query.data?.pages
        .flatMap((p) => p.items)
        .map((item) => {
          const snapshot = item.events.find((e) => e.snapshot)?.snapshot;
          const cycles = [...new Set(item.events.map((e) => e.cycle_id).filter(Boolean))];
          return (
            <details key={item.job_id} open={!!jobId}>
              <summary>
                {snapshot
                  ? `${snapshot.title} · ${snapshot.company ?? "Empresa sin confirmar"}`
                  : "Vacante · registro histórico sin detalles"}
              </summary>
              <p>
                Corridas de origen:{" "}
                {cycles.length
                  ? cycles.map((c) => c?.slice(0, 8)).join(", ")
                  : "Sin origen registrado (histórico)"}
                . Perfiles: {[...new Set(item.events.map((e) => e.profile_id))].join(", ")}
              </p>
              {!jobId && <a href={notificationLink(id, item.job_id)}>Ver vacante y cambios</a>}
              {item.events.map((event) => (
                <article key={event.id}>
                  <h3>{notificationLabels[event.kind]}</h3>
                  <p>
                    {date(event.created_at)} · versión de vacante{" "}
                    {event.job_version ?? "no registrada"}
                  </p>
                  {!event.snapshot ? (
                    <p>
                      Detalle minimizado o no registrado. Consulta la vacante para su estado actual.
                    </p>
                  ) : (
                    <dl>
                      {Object.entries(event.snapshot.changes).map(([field, value]) => (
                        <div key={field}>
                          <dt>{fields[field] ?? field}</dt>
                          <dd>
                            {value &&
                            typeof value === "object" &&
                            !Array.isArray(value) &&
                            "before" in value &&
                            "after" in value ? (
                              `${String(value.before ?? "desconocido")} → ${String(value.after ?? "desconocido")}`
                            ) : field === "evidence_url" ? (
                              <ExternalLink href={value}>
                                Ver fuente de la comprobación
                              </ExternalLink>
                            ) : (
                              String(value)
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </article>
              ))}
            </details>
          );
        })}
      {query.hasNextPage && (
        <button disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>
          Ver más vacantes del lote
        </button>
      )}
    </div>
  );
}
export function NotificationPreferences() {
  const query = useRead<NotificationState>("notifications.preferences");
  const retained = useRetained<NotificationState>("notification-preferences");
  const draft = retained.value,
    setDraft = retained.set;
  const write = useNotificationWrite();
  const state = draft ?? query.data;
  return (
    <section className="notification-preferences">
      <h2>Avisos de cambios</h2>
      <p>
        El historial se conserva aunque desactives el correo. Los detalles públicos se conservan 90
        días; después queda el registro mínimo. El resumen diario y los cierres se ajustan en
        Automatización.
      </p>
      {query.isPending && <p role="status">Consultando preferencias…</p>}
      {query.error && <p role="alert">No se pudieron consultar las preferencias.</p>}
      <WriteStatus write={write} />
      {state && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (query.data)
              void write
                .write("notifications.configure", {
                  expected_version: state.version,
                  live_email: state.live_email,
                  disclosure: state.disclosure,
                })
                .then((saved) => {
                  if (saved) setDraft(null);
                });
          }}
        >
          {draft && write.confirmedConflict && (
            <button
              type="button"
              onClick={async () => {
                if (
                  !window.confirm("¿Reaplicar tus preferencias sobre la versión actual consultada?")
                )
                  return;
                const current = await query.refetch();
                if (current.isError || !current.data || !(await write.discardRejected())) return;
                setDraft({ ...draft, version: current.data.version });
              }}
            >
              Reaplicar preferencias sobre versión actual
            </button>
          )}
          <fieldset disabled={write.pending || !!write.intent}>
            <label>
              <input
                type="checkbox"
                checked={state.live_email}
                onChange={(e) => setDraft({ ...state, live_email: e.target.checked })}
              />{" "}
              Enviar cambios agrupados cada 15 minutos
            </label>
            <label>
              Contenido del correo
              <select
                value={state.disclosure}
                onChange={(e) =>
                  setDraft({
                    ...state,
                    disclosure: e.target.value as NotificationState["disclosure"],
                  })
                }
              >
                <option value="generic">Resumen genérico</option>
                <option value="vacancy_summary">Puesto, empresa, cambios y enlaces</option>
              </select>
            </label>
            <p>El detalle no incluye CVs, nombres/correos de contactos ni mensajes privados.</p>
            {retained.error && <p role="alert">{retained.error}</p>}
            <button type="button" onClick={() => setDraft(null)} disabled={!draft}>
              Cancelar cambios
            </button>
            <button disabled={!draft || !navigator.onLine} type="submit">
              Guardar preferencias de avisos
            </button>
          </fieldset>
        </form>
      )}
    </section>
  );
}

function LazyBatch({ id, jobId, label }: { id: string; jobId?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{label ?? "Ver cambios del lote"}</summary>
      {open && <NotificationChanges id={id} {...(jobId ? { jobId } : {})} />}
    </details>
  );
}

export function NotificationEntry({ open }: { open: () => void }) {
  const query = useQuery({
    queryKey: ["notifications.list", { limit: 1 }],
    queryFn: async () =>
      notificationOutputs["notifications.list"].parse(
        await operation("notifications.list", { limit: 1 }),
      ),
    refetchInterval: 30000,
  });
  return (
    <button
      className="notification-entry"
      onClick={open}
      aria-label={`Abrir notificaciones${query.data ? `, ${query.data.unread_count} no leídas` : ""}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
      </svg>
      <span className="notification-entry-label">Notificaciones</span>
      {query.data?.unread_count ? (
        <span className="notification-count" aria-hidden="true">
          {query.data.unread_count}
        </span>
      ) : null}
    </button>
  );
}

export function VacancyNotificationHistory({ jobId }: { jobId: string }) {
  const query = useInfiniteQuery({
    queryKey: ["notifications.list", { job_id: jobId }],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      notificationOutputs["notifications.list"].parse(
        await operation("notifications.list", {
          job_id: jobId,
          limit: 10,
          ...(pageParam ? { cursor: pageParam } : {}),
        }),
      ),
    getNextPageParam: (p: NotificationList) => p.next_cursor ?? undefined,
  });
  return (
    <div>
      {query.isPending && <p role="status">Consultando el historial de esta vacante…</p>}
      {query.error && <p role="alert">No se pudo consultar el historial.</p>}
      {query.data?.pages
        .flatMap((p) => p.items)
        .map((batch) => (
          <LazyBatch
            key={batch.id}
            id={batch.id}
            jobId={jobId}
            label={`Cambios del ${date(batch.window_start)}`}
          />
        ))}
      {query.data && !query.data.pages[0]?.items.length && (
        <p>No hay cambios automatizados registrados para esta vacante.</p>
      )}
      {query.hasNextPage && (
        <button disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>
          Ver más cambios de esta vacante
        </button>
      )}
    </div>
  );
}
