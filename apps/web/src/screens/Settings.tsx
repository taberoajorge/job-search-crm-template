import { useRetained, retainRecovery } from "../shared/state/recovery";
import { NotificationPreferences } from "../shared/ui/notifications";
import { schemaVersion } from "../shared/state/storage";
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  backupTables,
  backupSchema,
  emailPreferences as emailPreferenceContract,
  parseOperation,
} from "@crm/contracts";
import {
  operation,
  OperationError,
  ownerId,
  requireSupabase,
  type Page,
  type RecordData,
} from "../shared/api/client";
import { subscribePush } from "../shared/api/push";
import {
  useLogout,
  useExactWrite,
  useNotice,
  useRead,
  useLookupRecords,
  useRecords,
  useRestricted,
  useEdits,
  exportDrafts,
  useEdit,
} from "../shared/state/crm";
import { text } from "../shared/state/model";
import { agent, Badge, Editor, options, Status } from "../shared/ui/controls";
import { CollectionPager, LookupStatus, useCollectionPage } from "../shared/ui/collections";
import { ResourceTable } from "../shared/ui/resource-table";
import { applyAppearance, readAppearance } from "../shared/theme/appearance";
export async function exportData() {
  const records: Record<string, unknown[]> = {};
  const unavailable: string[] = [];
  for (const [table, definition] of Object.entries(backupTables)) {
    const rows: unknown[] = [];
    let from = 0;
    while (true) {
      let query = requireSupabase().from(table).select(definition.columns).eq("user_id", ownerId);
      for (const field of definition.order) query = query.order(field);
      const { data, error } = await query.range(from, from + 49);
      if (error) {
        if (["42P01", "PGRST205"].includes(error.code) && !rows.length) {
          unavailable.push(`${table}: no disponible en este servidor`);
          break;
        }
        throw error;
      }
      rows.push(...data);
      if (!data.length) {
        records[table] = rows;
        break;
      }
      from += data.length;
    }
  }
  return backupSchema.parse({
    format: "job-search-crm-backup",
    format_version: 1,
    schema_version: schemaVersion,
    exported_at: new Date().toISOString(),
    owner_id: ownerId,
    records,
    coverage: {
      included: Object.keys(records),
      unavailable,
      excluded: [
        "Bytes privados de CV y URLs firmadas",
        "Autenticación y claves push",
        "Colas privadas de correo, embeddings y tombstones de borrado",
        "Copias externas y respaldos previos",
        "Borradores locales (exportación de recuperación separada)",
        "Credenciales de leases activos",
        "Restauración automática de este respaldo no compatible",
      ],
      consistency: "paginated_non_atomic",
      restore_supported: false,
    },
  });
}
export function Settings() {
  const [appearance, setAppearance] = useState(readAppearance);
  const [section, setSection] = useState(() => {
    const params = new URLSearchParams(location.search);
    const value = params.get("section") || (params.has("task") ? "tasks" : "notifications");
    return ["appearance", "notifications", "backups", "companies", "sources", "tasks"].includes(
      value,
    )
      ? value
      : "notifications";
  });
  const edits = useEdits();
  const notice = useNotice();
  const logout = useLogout();
  const pushWrite = useExactWrite("push-deactivation");
  const restricted = useRestricted();
  const importDraft = useRetained<string>("normalized-import");
  const importText = importDraft.value ?? "",
    setImportText = importDraft.set;
  const [taskId, setTaskId] = useState(new URLSearchParams(location.search).get("task") || "");
  const [busy, setBusy] = useState(false);
  const taskDialog = useRef<HTMLDialogElement>(null);
  const linkedTaskId = new URLSearchParams(location.search).get("task");
  useEffect(() => {
    if (
      linkedTaskId &&
      /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(linkedTaskId) &&
      !taskDialog.current?.open
    )
      taskDialog.current?.showModal();
  }, [linkedTaskId]);
  const showTask = (id: string) => {
    setTaskId(id);
    taskDialog.current?.showModal();
  };
  const companies = useLookupRecords("companies.list");
  const sources = useRecords("sources.list");
  const tasks = useInfiniteQuery({
    queryKey: ["tasks.list"],
    initialPageParam: null as string | null,
    getNextPageParam: (page: Page) => (page.has_more ? page.next_cursor : undefined),
    enabled: section === "tasks",
    queryFn: async ({ pageParam }): Promise<Page> => {
      const offset = Number(pageParam || 0);
      const { data, error } = await requireSupabase()
        .from("crm_jobs")
        .select("id,version,kind,state,attempts,result,error,created_at")
        .eq("user_id", ownerId)
        .order("created_at", { ascending: false })
        .range(offset, offset + 49);
      if (error) throw error;
      return {
        items: data as RecordData[],
        has_more: data.length === 50,
        next_cursor: data.length === 50 ? String(offset + 50) : null,
      };
    },
    refetchInterval: 15000,
  });
  const companyPage = useCollectionPage(companies);
  const sourcePage = useCollectionPage(sources);
  const taskRecords = tasks.data?.pages.flatMap((page) => page.items) || [];
  const taskPage = useCollectionPage({ ...tasks, records: taskRecords });
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Ajustes</h1>
        </div>
        <button
          onClick={() =>
            void logout().catch(() => notice("No se pudo cerrar la sesión; revisa tu conexión."))
          }
        >
          Cerrar sesión
        </button>
      </div>
      <nav className="settings-sections" aria-label="Secciones de ajustes">
        {[
          ["appearance", "Apariencia"],
          ["notifications", "Notificaciones"],
          ["backups", "Respaldos"],
          ["companies", "Empresas"],
          ["sources", "Fuentes"],
          ["tasks", "Tareas"],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-pressed={section === id}
            aria-controls={`settings-${id}`}
            onClick={() => {
              setSection(id!);
              const url = new URL(location.href);
              url.searchParams.set("section", id!);
              history.replaceState(null, "", url);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div id="settings-appearance" hidden={section !== "appearance"}>
        <section className="card">
          <h2>Apariencia en este dispositivo</h2>
          <label>
            Tema
            <select
              value={appearance}
              onChange={(event) => {
                const saved = applyAppearance(event.target.value);
                setAppearance(readAppearance());
                if (!saved)
                  notice(
                    "Tema aplicado. El navegador no permite guardarlo para la próxima visita.",
                  );
              }}
            >
              <option value="system">Automático (según el sistema)</option>
              <option value="light">Claro</option>
              <option value="dark">Oscuro</option>
            </select>
          </label>
          <p>La elección se guarda en este dispositivo y también se aplica al acceso.</p>
        </section>
      </div>
      <div id="settings-notifications" hidden={section !== "notifications"}>
        <NotificationPreferences />
        <section className="card">
          <h2>Notificaciones en este dispositivo</h2>
          <p>
            Recibe avisos genéricos cuando termine una tarea. Nunca incluyen detalles de contactos
            ni archivos. En iOS, instala la app en la pantalla de inicio antes de activarlas.
          </p>
          <button
            disabled={!navigator.onLine}
            onClick={async () => {
              try {
                await subscribePush();
                notice("Notificaciones activadas para este dispositivo.", "success");
              } catch (error) {
                notice(error instanceof Error ? error.message : "No se pudieron activar.");
              }
            }}
          >
            Activar o renovar notificaciones
          </button>
          <button
            disabled={!navigator.onLine}
            onClick={async () => {
              try {
                const reg = await navigator.serviceWorker?.getRegistration();
                const subscription = await reg?.pushManager.getSubscription();
                if (subscription) {
                  const result = await pushWrite.write("push.deactivate", {
                    endpoint: subscription.endpoint,
                  });
                  if (!result)
                    throw new Error("Resultado sin confirmar; reintenta la solicitud original.");
                  await subscription.unsubscribe();
                }
                notice("Notificaciones desactivadas.", "success");
              } catch {
                notice("No se pudieron desactivar. Reintenta con conexión.");
              }
            }}
          >
            Desactivar en este dispositivo
          </button>
        </section>
        {pushWrite.intent && (
          <div>
            <p>Desactivación sin confirmar.</p>
            <button
              disabled={pushWrite.pending || !navigator.onLine}
              onClick={async () => {
                const endpoint = pushWrite.intent?.input.endpoint;
                if (!(await pushWrite.retry())) return;
                // Confirmed on the server: also release the matching browser subscription.
                const reg = await navigator.serviceWorker?.getRegistration();
                const subscription = await reg?.pushManager.getSubscription();
                if (subscription?.endpoint === endpoint) await subscription?.unsubscribe();
                notice("Notificaciones desactivadas.", "success");
              }}
            >
              Reintentar desactivación original
            </button>
            {pushWrite.confirmedRejected && (
              <button disabled={pushWrite.pending} onClick={() => void pushWrite.discardRejected()}>
                Descartar solicitud rechazada
              </button>
            )}
          </div>
        )}
        <EmailNotifications />
      </div>
      <div id="settings-backups" hidden={section !== "backups"}>
        <section className="card">
          <h2>Exportar respaldo</h2>
          <button onClick={() => exportDrafts(edits.map((e) => e.edit))}>
            Exportar borradores pendientes (disponible sin conexión)
          </button>
          <p>
            Exporta las familias canónicas indicadas en el manifiesto, con exclusiones y lecturas
            paginadas no atómicas. CVs y borradores locales requieren respaldo separado. Este JSON
            no admite restauración automática.
          </p>
          <button
            disabled={busy || !navigator.onLine}
            onClick={async () => {
              if (!window.confirm("¿Descargar un respaldo que contiene tus datos privados?"))
                return;
              setBusy(true);
              try {
                const data = await exportData();
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = `crm-${new Date().toISOString().slice(0, 10)}.json`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                notice("Respaldo descargado.", "success");
              } catch (error) {
                notice(error instanceof Error ? error.message : "No se pudo exportar.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Preparando…" : "Descargar respaldo JSON"}
          </button>
        </section>
        <form
          className="card"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              const payload = JSON.parse(importText);
              if (payload?.format)
                throw new Error(
                  "Este respaldo no admite restauración automática. Usa un lote normalizado compatible.",
                );
              const input = { kind: "bulk_import", payload, idempotency_key: crypto.randomUUID() };
              parseOperation("tasks.submit", input);
              const result = (await restricted(
                "tasks.submit",
                input,
                "¿Importar este lote validado de hasta 50 registros?",
              )) as { task_id?: string } | null;
              if (result?.task_id) {
                setTaskId(result.task_id);
                importDraft.set(null);
              }
            } catch (error) {
              notice(error instanceof Error ? error.message : "JSON inválido.");
            }
          }}
        >
          <h2>Importar un lote normalizado</h2>
          <p>
            Usa el reporte del normalizador. Revisa los registros antes de confirmar; no pegues una
            instantánea legacy sin normalizar.
          </p>
          <label>
            Lote JSON
            <textarea
              rows={7}
              required
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={'{"import_namespace":"respaldo-2026","records":[…]}'}
            />
          </label>
          <button disabled={!navigator.onLine}>Validar y confirmar importación</button>
        </form>
      </div>
      <div id="settings-tasks" hidden={section !== "tasks"}>
        <section className="card">
          <h2>Tareas</h2>
          <label>
            ID de tarea
            <input value={taskId} onChange={(e) => setTaskId(e.target.value)} />
          </label>
          <button
            disabled={!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(taskId)}
            onClick={() => showTask(taskId)}
          >
            Consultar tarea por ID
          </button>
          <ResourceTable
            rows={taskPage.records}
            entity="tasks"
            label="Tareas"
            columns={[
              {
                key: "kind",
                label: "Tarea",
                render: (task) => (
                  <div className="resource-identity">
                    <strong>
                      {task.kind === "bulk_import"
                        ? "Importación de registros"
                        : task.kind === "embed_records"
                          ? "Preparar búsqueda"
                          : text(task.kind)}
                    </strong>
                    <span className="caption">{text(task.attempts) || "0"} intentos</span>
                  </div>
                ),
              },
              { key: "state", label: "Estado", render: (task) => <Badge value={task.state} /> },
            ]}
            actions={(task) => (
              <button onClick={() => showTask(task.id)}>Ver resultado de la tarea</button>
            )}
          />
          <CollectionPager page={taskPage} label="tareas" />
          <dialog ref={taskDialog} aria-label="Resultado de tarea">
            <div className="dialog-head">
              <h2>Resultado de tarea</h2>
              <button
                type="button"
                aria-label="Cerrar resultado"
                onClick={() => taskDialog.current?.close()}
              >
                ×
              </button>
            </div>
            {/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(taskId) && <Task id={taskId} />}
          </dialog>
          <Status query={{ ...tasks, records: taskRecords }} />
        </section>
      </div>
      <div id="settings-companies" hidden={section !== "companies"}>
        <section>
          <div className="section-heading">
            <h2>Empresas</h2>
            <Editor
              entity="companies"
              operation="companies.upsert"
              title="Agregar empresa"
              fields={[
                { name: "name", label: "Nombre", required: true },
                { name: "website_url", label: "Sitio web", type: "url" },
              ]}
            />
          </div>
          <LookupStatus query={companies} label="empresas" />
          <ResourceTable
            rows={companyPage.records}
            entity="companies"
            label="Empresas"
            columns={[
              {
                key: "name",
                label: "Empresa",
                render: (company) => (
                  <strong className="resource-identity">{text(company.name)}</strong>
                ),
              },
              {
                key: "state",
                label: "Estado",
                render: (company) => (company.archived_at ? "Archivada" : "Activa"),
              },
            ]}
            actions={(company) => <CompanyActions company={company} all={companies.records} />}
          />
          <CollectionPager page={companyPage} label="empresas" />
          <Status query={companies} />
        </section>
      </div>
      <div id="settings-sources" hidden={section !== "sources"}>
        <section>
          <h2>Fuentes</h2>
          <Editor
            entity="sources"
            operation="sources.upsert"
            title="Agregar fuente"
            fields={[
              { name: "name", label: "Nombre", required: true },
              {
                name: "kind",
                label: "Tipo",
                required: true,
                options: ["ats", "recruiter", "referral", "aggregator", "manual"].map((value) => ({
                  value,
                  label:
                    (
                      {
                        ats: "ATS",
                        recruiter: "Reclutador",
                        referral: "Referido",
                        aggregator: "Agregador",
                        manual: "Manual",
                      } as Record<string, string>
                    )[value] || value,
                })),
              },
              { name: "url", label: "Sitio web", type: "url" },
            ]}
            initial={{ kind: "manual" }}
          />
          <ResourceTable
            rows={sourcePage.records}
            entity="sources"
            label="Fuentes"
            columns={[
              {
                key: "name",
                label: "Fuente",
                render: (source) => (
                  <strong className="resource-identity">{text(source.name)}</strong>
                ),
              },
              {
                key: "kind",
                label: "Tipo",
                render: (source) =>
                  (
                    ({
                      ats: "ATS",
                      recruiter: "Reclutador",
                      referral: "Referido",
                      aggregator: "Agregador",
                      manual: "Manual",
                    }) as Record<string, string>
                  )[text(source.kind)] || text(source.kind),
              },
            ]}
            actions={(source) => (
              <Editor
                entity="sources"
                operation="sources.upsert"
                record={source}
                title="Editar fuente"
                fields={[
                  { name: "name", label: "Nombre", required: true },
                  { name: "url", label: "Sitio web", type: "url" },
                ]}
              />
            )}
          />
          <CollectionPager page={sourcePage} label="fuentes" />
          <Status query={sources} />
        </section>
      </div>
    </>
  );
}
export function EmailNotifications() {
  const client = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const intent = useRetained<Record<string, unknown>>("intent:email-preferences");
  const busy = useRef(false);
  async function send(input: Record<string, unknown>) {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setMessage("");
    try {
      await retainRecovery("intent:email-preferences", input);
      const updated = await emailPreferences(input);
      await retainRecovery("intent:email-preferences", null);
      client.setQueryData(["email.preferences"], updated);
      setMessage("Preferencia de correo confirmada.");
    } catch (failure) {
      if (
        failure instanceof OperationError &&
        ["CONFLICT", "VALIDATION_ERROR", "IDEMPOTENCY_CONFLICT"].includes(failure.code)
      ) {
        // Definitive rejection: nothing was written and an exact retry cannot succeed.
        try {
          await retainRecovery("intent:email-preferences", null);
        } catch {
          /* The retained intent stays retryable. */
        }
        await client.invalidateQueries({ queryKey: ["email.preferences"] });
        setMessage(
          `No se aplicó tu cambio (${input.enabled ? "activar" : "desactivar"} correo): la preferencia cambió o no es válida. Revisa el valor actual y vuelve a intentarlo.`,
        );
      } else
        setMessage("Resultado sin confirmar. La solicitud original se conserva para reintentar.");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  const preferences = useQuery({
    queryKey: ["email.preferences"],
    queryFn: () => emailPreferences({}),
  });
  return (
    <section className="card">
      <h2>Notificaciones por correo</h2>
      <p>
        Avisos genéricos cuando termine una tarea, enviados solo al correo de tu cuenta. Puedes
        desactivarlos aquí en cualquier momento.
      </p>
      <p>
        {preferences.data
          ? preferences.data.enabled
            ? "Correo activado."
            : "Correo desactivado."
          : "Consultando tu preferencia…"}
      </p>
      {preferences.isError && <p role="alert">No se pudo consultar la preferencia de correo.</p>}
      {preferences.data ? (
        <button
          disabled={saving || !!intent.value || !navigator.onLine}
          onClick={async () => {
            if (!preferences.data || !navigator.onLine) return;
            if (intent.value) return;
            await send({
              enabled: !preferences.data.enabled,
              expected_version: preferences.data.version,
              idempotency_key: crypto.randomUUID(),
            });
          }}
        >
          {saving
            ? "Guardando…"
            : preferences.data.enabled
              ? "Desactivar correo"
              : "Activar correo"}
        </button>
      ) : (
        <button
          disabled={!navigator.onLine || preferences.isFetching}
          onClick={() => void preferences.refetch()}
        >
          Reintentar consulta
        </button>
      )}
      {message && <p role="status">{message}</p>}
      {intent.error && <p role="alert">{intent.error}</p>}
      {intent.value && (
        <button disabled={saving || !navigator.onLine} onClick={() => void send(intent.value!)}>
          Reintentar preferencia original
        </button>
      )}
    </section>
  );
}
async function emailPreferences(
  input: Record<string, unknown>,
): Promise<{ enabled: boolean; version: number }> {
  const { data, error } = await requireSupabase().rpc("crm_email_preferences", {
    p_input: emailPreferenceContract.input.parse(input),
  });
  const parsed = error ? undefined : emailPreferenceContract.output.safeParse(data);
  if (!parsed?.success) throw new Error("No se pudo consultar o guardar la preferencia de correo.");
  if ("error" in parsed.data)
    throw new OperationError(parsed.data.error.code, parsed.data.error.message);
  return parsed.data;
}
function Task({ id }: { id: string }) {
  const task = useRead<RecordData>("tasks.get", { task_id: id });
  const restricted = useRestricted();
  return (
    <article {...agent("tasks", id, "result")}>
      <Status query={task} />
      {task.data && (
        <>
          <Badge value={task.data.state} />
          <pre>
            {JSON.stringify(
              task.data.result || task.data.error || { attempts: task.data.attempts },
              null,
              2,
            )}
          </pre>
          {task.data.state === "queued" && (
            <button
              onClick={() =>
                void restricted(
                  "tasks.cancel",
                  { task_id: id, expected_version: task.data?.version },
                  "¿Cancelar esta tarea pendiente?",
                )
              }
            >
              Cancelar tarea pendiente
            </button>
          )}
          <button onClick={() => void task.refetch()}>Actualizar resultado</button>
        </>
      )}
    </article>
  );
}
function CompanyActions({ company: c, all }: { company: RecordData; all: RecordData[] }) {
  const restricted = useRestricted();
  const edit = useEdit(c.id);
  const notice = useNotice();
  const retained = useRetained<{ target: string; reason: string }>(`company-actions:${c.id}`);
  const values = retained.value ?? { target: "", reason: "" };
  const { target, reason } = values;
  const setTarget = (value: string) => retained.set({ ...values, target: value });
  const setReason = (value: string) => retained.set({ ...values, reason: value });
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [kind, setKind] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  // After the owner's own confirmed archive or merge, the new version is expected: finish the action.
  const confirmed = (result: unknown, message: string) => {
    if (!result) return;
    setPreview(null);
    setKind("");
    retained.set(null);
    dialog.current?.close();
    notice(message, "success");
  };
  const previewCurrent =
    preview &&
    (kind === "archive"
      ? preview.version === c.version
      : kind === "merge"
        ? preview.source_version === c.version &&
          preview.target_version === all.find((company) => company.id === target)?.version
        : true);
  return (
    <>
      {c.archived_at ? (
        <button
          onClick={() =>
            edit("companies.upsert", { id: c.id, expected_version: c.version, archived_at: null })
          }
        >
          Restaurar empresa
        </button>
      ) : null}
      <Editor
        entity="companies"
        operation="companies.upsert"
        record={c}
        title="Editar empresa"
        fields={[
          { name: "name", label: "Nombre", required: true },
          { name: "website_url", label: "Sitio web", type: "url" },
          { name: "product", label: "Producto" },
          { name: "type", label: "Tipo de empresa" },
        ]}
      />
      <button onClick={() => dialog.current?.showModal()}>Actividad, archivo y fusión</button>
      <dialog ref={dialog} aria-label={`Acciones de ${text(c.name)}`}>
        <div className="dialog-head">
          <h2>{text(c.name)}</h2>
          <button
            type="button"
            aria-label="Cerrar acciones de empresa"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <button
          onClick={async () => {
            try {
              setPreview(
                (await operation("companies.health", { id: c.id })) as Record<string, unknown>,
              );
              setKind("health");
            } catch {
              notice("No se pudo consultar la empresa.");
            }
          }}
        >
          Consultar actividad
        </button>
        <label>
          Motivo
          <input
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <label>
          Empresa destino para fusionar
          <select
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setPreview(null);
            }}
          >
            <option value="">Selecciona destino</option>
            {options(all.filter((other) => other.id !== c.id)).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button
            disabled={!navigator.onLine || !reason}
            onClick={async () => {
              try {
                setPreview(
                  (await operation("companies.preview_archive", { id: c.id })) as Record<
                    string,
                    unknown
                  >,
                );
                setKind("archive");
              } catch {
                notice("No se pudo preparar el archivo.");
              }
            }}
          >
            Revisar archivo
          </button>
          <button
            disabled={!navigator.onLine || !reason || !target}
            onClick={async () => {
              try {
                setPreview(
                  (await operation("companies.preview_merge", {
                    source_id: c.id,
                    target_id: target,
                  })) as Record<string, unknown>,
                );
                setKind("merge");
              } catch {
                notice("No se pudo preparar la fusión.");
              }
            }}
          >
            Revisar fusión
          </button>
        </div>
        {preview != null && <pre>{JSON.stringify(preview, null, 2)}</pre>}
        {preview != null && !previewCurrent && (
          <p role="status">La empresa cambió. Vuelve a revisar antes de confirmar.</p>
        )}
        {preview != null && kind === "archive" && (
          <button
            disabled={!navigator.onLine || !previewCurrent}
            onClick={async () =>
              confirmed(
                await restricted(
                  "companies.archive",
                  { id: c.id, expected_version: preview.version, reason },
                  "¿Archivar la empresa y los registros mostrados en la vista previa?",
                ),
                "Empresa archivada.",
              )
            }
          >
            Confirmar archivo
          </button>
        )}
        {preview != null && kind === "merge" && (
          <button
            disabled={!navigator.onLine || !previewCurrent}
            onClick={async () =>
              confirmed(
                await restricted(
                  "companies.merge",
                  {
                    source_id: c.id,
                    source_version: preview.source_version,
                    target_id: target,
                    target_version: preview.target_version,
                    reason,
                  },
                  "¿Fusionar estas empresas según la vista previa?",
                ),
                "Empresas fusionadas.",
              )
            }
          >
            Confirmar fusión
          </button>
        )}
      </dialog>
    </>
  );
}
