import { JevClassification } from "../shared/ui/JevClassification";
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { policySchema, outputSchemas, type Policy, type Work } from "@crm/contracts";
import { operation } from "../shared/api/client";

import { useExactWrite } from "../shared/state/crm";
import { useRetained } from "../shared/state/recovery";
import { DetailTabs, agent } from "../shared/ui/controls";
import { CollectionPager, useCollectionPage } from "../shared/ui/collections";

// A draft holds the whole policy; reapply only the fields the owner changed from its base so
// changes made elsewhere (pause, budgets, opt-ins) survive.
export function rebaseDraft(draft: Policy, base: Policy, current: Policy) {
  const changed = (Object.keys(draft) as (keyof Policy)[]).filter(
    (key) => JSON.stringify(draft[key]) !== JSON.stringify(base[key]),
  );
  return {
    changed,
    policy: {
      ...current,
      ...Object.fromEntries(changed.map((key) => [key, draft[key]])),
    } as Policy,
  };
}
export function Automation() {
  const [section, setSection] = useState("summary");
  const tabId = useId();
  const query = useQuery({
    queryKey: ["automation"],
    queryFn: async () =>
      outputSchemas["automation.status"]!.parse(await operation("automation.status", {})) as any,
    refetchInterval: 30000,
    refetchOnReconnect: true,
  });
  const retained = useRetained<{ policy: Policy; version: number; base?: Policy }>(
    "automation-policy",
  );
  const data = query.data;
  const draft = retained.value?.policy ?? null;
  const setDraft = (value: Policy | null) =>
    retained.set(
      value
        ? {
            policy: value,
            version: retained.value?.version ?? data.policy_version,
            base: retained.value ? retained.value.base : data.policy,
          }
        : null,
    );
  const write = useExactWrite("automation");
  const { pending, intent } = write;
  const [error, setError] = useState("");
  const policy = draft ?? data?.policy;
  async function submit(request: {
    name: string;
    input: Record<string, unknown>;
    clearDraft?: boolean;
  }) {
    const result = await write.send(request);
    if (result && request.clearDraft) setDraft(null);
  }
  async function save(value: Policy, clearDraft = true) {
    setError("");
    try {
      await submit({
        name: "automation.configure",
        clearDraft,
        input: {
          idempotency_key: crypto.randomUUID(),
          expected_version: clearDraft
            ? (retained.value?.version ?? data.policy_version)
            : data.policy_version,
          policy: policySchema.parse(value),
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revisa los ajustes");
    }
  }
  async function trigger(scope: "discovery" | "existing" | "classification") {
    await submit({
      name: "automation.trigger",
      input: { idempotency_key: crypto.randomUUID(), retry_failed: true, scope, on_demand: true },
    });
  }
  const date = (v: string | null) =>
    v
      ? new Date(v).toLocaleString("es-MX", {
          timeZone: data?.policy?.timezone ?? "America/Mexico_City",
        })
      : "Sin confirmar";
  return (
    <section className="screen automation-workspace">
      <h1>Automatización</h1>
      <p>Búsquedas, investigación y preparación de vacantes.</p>
      {query.dataUpdatedAt > 0 && (
        <p className="caption">
          Observado: {new Date(query.dataUpdatedAt).toLocaleString("es-MX")}
          {!navigator.onLine ? " · Sin conexión, datos guardados" : ""}
        </p>
      )}
      {query.isError && <button onClick={() => void query.refetch()}>Reintentar consulta</button>}
      {query.isPending && <p role="status">Consultando el coordinador…</p>}
      {(query.error || error || write.error || retained.error) && (
        <p role="alert">{error || write.error || retained.error || query.error?.message}</p>
      )}
      {intent && (
        <div>
          <p>El cambio conserva su solicitud original para evitar duplicados.</p>
          <button disabled={pending} onClick={() => void write.retry()}>
            Reintentar el mismo cambio
          </button>{" "}
          {write.confirmedRejected && (
            <button disabled={pending} onClick={() => void write.discardRejected()}>
              Descartar solicitud rechazada; conservar borrador
            </button>
          )}
          {write.confirmedConflict && draft && (
            <button
              disabled={pending}
              onClick={async () => {
                const latest = await query.refetch();
                if (latest.isError || !latest.data) return;
                const current = latest.data.policy as Policy;
                const next = rebaseDraft(draft, retained.value?.base ?? current, current);
                const lines = next.changed.map(
                  (key) =>
                    `${key}: ${JSON.stringify(current[key])} → ${JSON.stringify(draft[key])}`,
                );
                if (
                  !window.confirm(
                    `¿Reaplicar solo tus cambios sobre la versión actual?\n${lines.join("\n") || "No hay cambios propios."}`,
                  ) ||
                  !(await write.discardRejected())
                )
                  return;
                retained.set({
                  policy: next.policy,
                  version: latest.data.policy_version,
                  base: current,
                });
              }}
            >
              Reaplicar borrador sobre versión actual
            </button>
          )}
          <button
            disabled={pending}
            onClick={() => {
              void query.refetch();
            }}
          >
            Revisar el estado actual
          </button>
        </div>
      )}
      {data && (
        <>
          {policy ? (
            <>
              <p className="caption">
                {data.policy.enabled ? "Activa" : "Pausada"} · Hora de referencia:{" "}
                {data.policy.timezone}
              </p>
              <div className="automation-actions">
                <button
                  disabled={pending || !!intent || !navigator.onLine}
                  onClick={() =>
                    void save({ ...data.policy, enabled: !data.policy.enabled }, false)
                  }
                >
                  {data.policy.enabled ? "Pausar" : "Reanudar"}
                </button>{" "}
                <button
                  disabled={pending || !!intent || !navigator.onLine}
                  onClick={() => void trigger("discovery")}
                >
                  Buscar vacantes nuevas
                </button>
                <button
                  disabled={pending || !!intent || !navigator.onLine}
                  onClick={() => void trigger("existing")}
                >
                  Investigar vacantes existentes
                </button>
                <button
                  disabled={pending || !!intent || !navigator.onLine}
                  onClick={() => void trigger("classification")}
                >
                  Clasificar con Jev ahora
                </button>
              </div>
              <p className="caption">
                Estas acciones ejecutan una vez aunque el flujo periódico esté pausado. No cambian
                tus opciones guardadas.
              </p>
              <p className="caption">
                Vacantes nuevas:{" "}
                {data.policy.enabled && data.policy.discovery_enabled ? "activadas" : "pausadas"} ·
                Vacantes existentes:{" "}
                {data.policy.enabled && data.policy.research_enabled ? "activadas" : "pausadas"} ·
                Clasificación Jev:{" "}
                {!data.policy.jev_enabled
                  ? "desactivada"
                  : data.policy.enabled
                    ? "activada"
                    : "configurada (en pausa)"}
              </p>
              <DetailTabs
                id={tabId}
                items={[
                  ["summary", "Resumen"],
                  ["profiles", "Perfiles"],
                  ["queue", "Cola"],
                  ["settings", "Configuración"],
                ]}
                value={section}
                onChange={setSection}
              />
              <div
                role="tabpanel"
                id={`${tabId}-summary-panel`}
                aria-labelledby={`${tabId}-summary-tab`}
                hidden={section !== "summary"}
              >
                <h2>Estado de la automatización</h2>
                <p role="status">
                  {data.executor_stale ? "Ejecutor sin señal reciente" : "Ejecutor conectado"} ·
                  Última señal: {date(data.heartbeat_at)} · {data.executor_status ?? "Sin estado"}
                </p>

                <div className="automation-grid">
                  <article className="automation-card">
                    <h3>Próxima búsqueda</h3>
                    <strong>
                      {data.policy.enabled && data.policy.discovery_enabled
                        ? date(
                            data.profiles
                              .filter((p: any) => p.next_due_at)
                              .map((p: any) => p.next_due_at)
                              .sort()[0] ?? null,
                          )
                        : "Pausada"}
                    </strong>
                    <p>
                      {data.policy.enabled && data.policy.discovery_enabled
                        ? `Cada ${data.policy.interval_hours} horas`
                        : "Búsquedas pausadas"}{" "}
                      · {data.profiles.length} perfiles
                    </p>
                  </article>
                  {(["daily", "monthly"] as const).map((period) => {
                    const limit =
                      period === "daily" ? data.policy.exa_daily_usd : data.policy.exa_monthly_usd;
                    return (
                      <article className="automation-card" key={period}>
                        <h3>Exa · {period === "daily" ? "hoy" : "este mes"}</h3>
                        <strong>
                          US${data.spend[period].toFixed(2)} / US${limit.toFixed(2)}
                        </strong>
                        <progress
                          aria-label={`Presupuesto ${period === "daily" ? "diario" : "mensual"}`}
                          value={Math.min(data.spend[period], limit)}
                          max={limit || 1}
                        />
                        <p>Gasto reservado o informado</p>
                      </article>
                    );
                  })}
                </div>
                <p>Los borradores requieren tu revisión antes de aplicar o contactar.</p>
                <p>
                  La frecuencia controla las búsquedas nuevas. La cola también investiga las
                  vacantes existentes en radar y por revisar, dentro del presupuesto disponible.
                </p>
              </div>
              <div
                role="tabpanel"
                id={`${tabId}-settings-panel`}
                aria-labelledby={`${tabId}-settings-tab`}
                hidden={section !== "settings"}
              >
                <h2>Configuración</h2>
                {draft && <p role="status">Tienes ajustes sin guardar.</p>}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save(policy);
                  }}
                >
                  <fieldset className="automation-settings" disabled={pending || !!intent}>
                    <legend>Qué hace la automatización</legend>
                    <label>
                      <input
                        type="checkbox"
                        checked={policy.discovery_enabled}
                        onChange={(e) =>
                          setDraft({ ...policy, discovery_enabled: e.target.checked })
                        }
                      />
                      Descubrir vacantes nuevas
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={policy.research_enabled}
                        aria-describedby={`${tabId}-research-hint`}
                        onChange={(e) =>
                          setDraft({ ...policy, research_enabled: e.target.checked })
                        }
                      />
                      Investigar vacantes existentes
                    </label>
                    <p id={`${tabId}-research-hint`}>
                      Investiga empresa, personas de contacto y borradores de conversación para
                      radar y por revisar. También prepara entrevistas y verifica disponibilidad. No
                      postula ni envía mensajes.
                    </p>
                    <label>
                      <input
                        type="checkbox"
                        checked={policy.jev_enabled}
                        aria-describedby={`${tabId}-jev-hint`}
                        onChange={(e) => setDraft({ ...policy, jev_enabled: e.target.checked })}
                      />
                      Clasificar vacantes con Jev
                    </label>
                    <p id={`${tabId}-jev-hint`}>
                      Clasifica por perfil antes de investigar. Puedes apagarlo sin detener los
                      otros flujos. El límite total de Jev es US$5; no se recarga automáticamente.
                    </p>
                  </fieldset>
                  <fieldset className="automation-settings" disabled={pending || !!intent}>
                    <legend>Cuándo se ejecuta</legend>
                    <label>
                      Zona horaria IANA
                      <input
                        required
                        value={policy.timezone}
                        onChange={(e) => setDraft({ ...policy, timezone: e.target.value })}
                      />
                    </label>
                    <label>
                      Cada cuántas horas{" "}
                      <input
                        type="number"
                        min={2}
                        max={168}
                        required
                        value={policy.interval_hours}
                        onChange={(e) =>
                          setDraft({ ...policy, interval_hours: Number(e.target.value) })
                        }
                      />
                    </label>
                  </fieldset>
                  <fieldset className="automation-settings" disabled={pending || !!intent}>
                    <legend>Límites de investigación</legend>
                    <p>
                      Gasto de Exa informado: consulta Resumen. El límite total de Jev es US$5, de
                      solo lectura; su saldo restante todavía no se muestra aquí.
                    </p>
                    <label>
                      Exa: máximo diario (US$){" "}
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step="0.01"
                        required
                        value={policy.exa_daily_usd}
                        onChange={(e) =>
                          setDraft({ ...policy, exa_daily_usd: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label>
                      Exa: máximo mensual (US$){" "}
                      <input
                        type="number"
                        min={0}
                        max={1000}
                        step="0.01"
                        required
                        value={policy.exa_monthly_usd}
                        onChange={(e) =>
                          setDraft({ ...policy, exa_monthly_usd: Number(e.target.value) })
                        }
                      />
                    </label>
                  </fieldset>
                  <fieldset
                    className="automation-settings"
                    disabled={pending || !!intent}
                    aria-describedby={`${tabId}-notices-hint`}
                  >
                    <legend>Avisos</legend>
                    <p id={`${tabId}-notices-hint`}>
                      Correos a la cuenta propietaria configurada; no se envían mensajes a
                      contactos.
                    </p>
                    <label>
                      <input
                        type="checkbox"
                        checked={policy.digest_email}
                        onChange={(e) => setDraft({ ...policy, digest_email: e.target.checked })}
                      />{" "}
                      Resumen diario por correo
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={policy.closure_email}
                        onChange={(e) => setDraft({ ...policy, closure_email: e.target.checked })}
                      />{" "}
                      Avisos de publicaciones confirmadas como cerradas
                    </label>
                  </fieldset>
                  <div className="actions">
                    <button
                      type="button"
                      disabled={!draft || pending || !!intent}
                      onClick={() => setDraft(null)}
                    >
                      Cancelar cambios
                    </button>
                    <button type="submit" disabled={!draft || pending || !!intent}>
                      Guardar cambios
                    </button>
                  </div>
                </form>
                <p>
                  Modelo: {data.policy.model} · razonamiento {data.policy.effort}. Fuentes:{" "}
                  {data.policy.sources.join(", ")}.
                </p>
              </div>
              <div
                role="tabpanel"
                id={`${tabId}-profiles-panel`}
                aria-labelledby={`${tabId}-profiles-tab`}
                hidden={section !== "profiles"}
              >
                <h2>Perfiles y próximas búsquedas</h2>
                <ul className="automation-grid automation-profiles">
                  {data.profiles.map((p: any) => (
                    <li className="automation-card" key={p.id}>
                      <h3>{profileLabel(p.id)}</h3>
                      <p>
                        Próxima búsqueda:{" "}
                        {data.policy.enabled && data.policy.discovery_enabled
                          ? date(p.next_due_at)
                          : "Pausada"}
                      </p>
                      <a href="/?screen=resumes">Ver CVs</a>
                      <p>{p.criteria.terms.join(", ")}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <p>
              La automatización aún no está configurada. No se harán búsquedas ni gastos hasta
              guardar una política con los CVs confirmados.
            </p>
          )}
          <div
            role="tabpanel"
            id={`${tabId}-queue-panel`}
            aria-labelledby={`${tabId}-queue-tab`}
            hidden={policy && section !== "queue"}
          >
            <WorkQueue work={data.work} date={date} />
          </div>
        </>
      )}
    </section>
  );
}

function profileLabel(id: string) {
  const [track, country] = id.split("-");
  return `${({ ai: "Inteligencia artificial", general: "Full stack", backend: "Backend / plataforma", frontend: "Frontend" } as Record<string, string>)[track!] ?? track} · ${country === "MX" ? "México" : country === "PE" ? "Perú" : country}`;
}
// Work queued before a CV is chosen carries a placeholder profile_id; show only what is known.
export function workProfile(w: Work) {
  const chosen = (w.checkpoint.selection as { profile_id?: unknown } | null | undefined)
    ?.profile_id;
  if (typeof chosen === "string") return profileLabel(chosen);
  if (w.checkpoint.phase === "profile-review") return "Perfil requiere revisión";
  if (w.checkpoint.needs_profile === true || w.checkpoint.phase === "radar-backlog")
    return "Perfil por determinar";
  return profileLabel(w.profile_id);
}
const kindLabels: Record<string, string> = {
  classify: "Clasificación Jev",
  discovery: "Búsqueda",
  research: "Investigación web",
  prepare: "Preparación",
  interview: "Preparación de entrevista",
  revalidate: "Verificar disponibilidad",
};
const stateLabels: Record<string, string> = {
  queued: "En cola",
  running: "En proceso",
  waiting: "En espera",
  blocked: "Bloqueado",
  failed: "Falló",
  completed: "Completado",
  cancelled: "Cancelado",
};
function WorkQueue({ work, date }: { work: Work[]; date: (value: string | null) => string }) {
  const [selection, setSelection] = useState<Work | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const queueHeading = useRef<HTMLHeadingElement>(null);
  const currentSelection = selection ? work.find((item) => item.id === selection.id) : undefined;
  const selected = currentSelection ?? selection;
  useEffect(() => {
    if (selection && !dialog.current?.open) dialog.current?.showModal();
  }, [selection]);
  const [filter, setFilter] = useState("active"),
    [kind, setKind] = useState("");
  const records = work.filter(
    (w) =>
      (filter === "all" ||
        (["completed", "cancelled"].includes(w.state)
          ? filter === "history"
          : filter === "active")) &&
      (!kind || w.kind === kind),
  );
  const page = useCollectionPage(
    {
      records,
      hasNextPage: false,
      isFetching: false,
      fetchNextPage: async () => ({ isError: false }),
    },
    `${filter}:${kind}`,
    6,
  );
  return (
    <>
      <h2 ref={queueHeading} tabIndex={-1}>
        Cola y resultados
      </h2>
      <p>
        Últimos {work.length} trabajos cargados. Esta vista muestra actividad reciente, no el total
        de la cola.
      </p>
      <div className="automation-filters">
        <label>
          Mostrar
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="active">Pendientes y en proceso</option>
            <option value="history">Historial</option>
            <option value="all">Todos los recientes</option>
          </select>
        </label>
        <label>
          Tipo de trabajo
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Todos los tipos</option>
            {Object.entries(kindLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!records.length && <p role="status">No hay trabajos recientes con estos filtros.</p>}
      <ul className="automation-work-list">
        {(page.records as Work[]).map((w) => (
          <li className="automation-card" key={w.id}>
            <div className="automation-work-heading">
              <strong>{kindLabels[w.kind]}</strong>
              <span className="automation-state">{stateLabels[w.state]}</span>
            </div>
            <p>
              {workProfile(w)} · intento {w.attempts}
            </p>
            <small>Actualizado: {date(w.updated_at)}</small>
            <button
              {...agent("automation", w.id, "preview")}
              onClick={(event) => {
                trigger.current = event.currentTarget;
                setSelection(w);
              }}
            >
              Ver detalles
            </button>
          </li>
        ))}
      </ul>
      <CollectionPager page={page} label="trabajos recientes filtrados" />
      <dialog
        ref={dialog}
        className="queue-detail"
        aria-label="Detalles del trabajo"
        onClose={() => {
          setSelection(null);
          if (trigger.current?.isConnected) trigger.current.focus();
          else queueHeading.current?.focus();
        }}
      >
        <div className="dialog-head">
          <h2>Detalles del trabajo</h2>
          <button aria-label="Cerrar detalles del trabajo" onClick={() => dialog.current?.close()}>
            ×
          </button>
        </div>
        {selected && (
          <>
            {!currentSelection && (
              <p role="status">
                Este trabajo ya no aparece en la actividad reciente. Estos detalles son los últimos
                consultados.
              </p>
            )}
            <h3>
              {kindLabels[selected.kind]} · {workProfile(selected)}
            </h3>
            <p>{stateLabels[selected.state]}</p>
            <WorkDetails w={selected} date={date} />
          </>
        )}
      </dialog>
    </>
  );
}

function WorkDetails({ w, date }: { w: Work; date: (value: string | null) => string }) {
  return (
    <div>
      {" "}
      {w.state === "waiting" && <p>Próximo intento: {date(w.next_attempt_at)}</p>}
      {w.error === "BUDGET_EXHAUSTED" && (
        <p>
          Presupuesto disponible agotado al programar este intento. La investigación espera un nuevo
          intento con saldo disponible.
        </p>
      )}
      {w.job_id && <a href={`/?screen=pipeline&job=${w.job_id}`}>Ver vacante y preparación</a>}
      {(w.error || Array.isArray(w.checkpoint.gaps)) && (
        <details>
          <summary>Detalles del resultado</summary>
          {w.error && <p>{w.error}</p>}
          {Array.isArray(w.checkpoint.gaps) && <p>{w.checkpoint.gaps.join("; ")}</p>}
        </details>
      )}
      {w.checkpoint.jev && typeof w.checkpoint.jev === "object" && (
        <>
          {(Object.hasOwn(w.checkpoint.jev, "status")
            ? [w.checkpoint.jev]
            : Object.values(w.checkpoint.jev)
          )
            .filter((value) => value && typeof value === "object" && !Array.isArray(value))
            .map((value, index) => (
              <JevClassification
                key={index}
                expanded
                fromList
                job={{
                  id: w.id,
                  version: w.version,
                  triage: { state: w.state, updated_at: w.updated_at, stale: false, jev: value },
                }}
              />
            ))}
        </>
      )}
      {typeof w.checkpoint.selection_reason === "string" && (
        <p>Motivo del perfil elegido: {w.checkpoint.selection_reason}</p>
      )}
      {typeof w.checkpoint.research_gap === "string" && (
        <p>Pendiente de investigación: {w.checkpoint.research_gap}</p>
      )}
      {w.checkpoint.research_output && (
        <details>
          <summary>Resultado registrado de investigación</summary>
          <p className="message-body">
            {typeof w.checkpoint.research_output === "string"
              ? w.checkpoint.research_output
              : JSON.stringify(w.checkpoint.research_output, null, 2)}
          </p>
        </details>
      )}
      <small>Actualizado: {date(w.updated_at)}</small>
    </div>
  );
}
