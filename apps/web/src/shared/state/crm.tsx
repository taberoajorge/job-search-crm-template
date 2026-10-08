import { parseOperation } from "@crm/contracts";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type Mutation,
} from "@tanstack/react-query";
import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
  type Persister,
} from "@tanstack/react-query-persist-client";
import {
  operation,
  OperationError,
  ownerId,
  supabase,
  type Page,
  type RecordData,
} from "../api/client";
import { persister, schemaVersion, stored } from "./storage";
import {
  clearRecovery,
  recoverySnapshot,
  restoreRecovery,
  retainRecovery,
  replaceRecovery,
  useRetained,
} from "./recovery";
export type Edit = {
  operation: string;
  entity_id: string;
  input: Record<string, unknown>;
  id: string;
  order: number;
};
export const ordinary = new Set([
  "jobs.upsert",
  "jobs.transition",
  "contacts.upsert",
  "outreach.draft",
  "outreach.queue",
  "interviews.upsert",
  "companies.upsert",
  "sources.upsert",
]);
export function makeClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { gcTime: 7 * 86400000, staleTime: 30000, retry: false },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  // Successful edits are never persisted or shown; drop them once announced so a long-lived
  // session does not keep every edit in memory (gcTime stays Infinity for unfinished ones).
  client.getMutationCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "success")
      setTimeout(() => client.getMutationCache().remove(event.mutation), 0);
  });
  // Queued edits of one record share the baseline version the owner saw. After an earlier edit
  // from that baseline commits, later ones are rebased onto its result; other changes still conflict.
  const committed = new Map<string, { from: unknown; to: number }>();
  client.setMutationDefaults(["ordinary-edit"], {
    mutationFn: async (queued: Edit) => {
      const sent = (recoverySnapshot()[`edit:${queued.id}`] as Edit | undefined) ?? queued;
      const step = committed.get(queued.entity_id);
      const edit =
        step && sent.input.expected_version != null && sent.input.expected_version === step.from
          ? { ...sent, input: { ...sent.input, expected_version: step.to } }
          : sent;
      if (!ordinary.has(edit.operation))
        throw new OperationError("VALIDATION_ERROR", "Operación no permitida sin conexión.");
      const blocked = client
        .getMutationCache()
        .getAll()
        .find(
          (m) =>
            m.state.status === "error" &&
            (m.state.variables as Edit)?.entity_id === edit.entity_id &&
            (m.state.variables as Edit)?.id !== edit.id &&
            (m.state.variables as Edit).order < edit.order,
        );
      if (blocked)
        throw new OperationError("BLOCKED", "Resuelve el cambio anterior de este registro.");
      await retainRecovery(`edit:${edit.id}`, edit);
      const result = await operation<RecordData>(edit.operation, edit.input);
      const saved = [result, result?.job, result?.contact].find(
        (r) => (r as RecordData | undefined)?.id === edit.entity_id,
      ) as RecordData | undefined;
      if (typeof saved?.version === "number" && queued.input.expected_version != null)
        committed.set(edit.entity_id, { from: queued.input.expected_version, to: saved.version });
      await retainRecovery(`edit:${edit.id}`, null);
      await client.invalidateQueries();
      return result;
    },
  });
  return client;
}
// resumePausedMutations skips edits persisted mid-request (restored as pending, not paused).
// Continuing every pending edit resumes both; the mutation scope keeps per-record order.
export function resumeEdits(client: QueryClient) {
  return Promise.all(
    client
      .getMutationCache()
      .getAll()
      .filter((m) => m.state.status === "pending")
      .map((m) => m.continue().catch(() => {})),
  );
}
type NoticeKind = "success" | "info" | "error";
const Notice = createContext<(message: string, kind?: NoticeKind) => void>(() => {});
function savedKind(data: unknown): NoticeKind {
  return Array.isArray((data as RecordData | null)?.duplicate_hints) &&
    ((data as RecordData).duplicate_hints as unknown[]).length
    ? "error"
    : "success";
}
export function savedNotice(data: unknown) {
  const record = data as RecordData | null;
  if (
    record?.erased ||
    (record?.contact as RecordData | undefined)?.erased ||
    (record?.event as RecordData | undefined)?.erased
  )
    return "Solicitud original reconocida. Los datos personales ya fueron borrados; no se recrearon.";
  const hints = record?.duplicate_hints;
  return Array.isArray(hints) && hints.length
    ? `Cambio guardado. Posibles duplicados: ${hints.length}. Revisa el mismo título y empresa en Pipeline antes de continuar.`
    : "Cambio guardado.";
}
export function useNotice() {
  return useContext(Notice);
}
const Logout = createContext<() => Promise<void>>(async () => {});
export function useLogout() {
  return useContext(Logout);
}
export function CrmProvider({
  children,
  logout,
}: {
  children: ReactNode;
  logout: () => Promise<void>;
}) {
  const [client] = useState(makeClient);
  const [notice, updateNotice] = useState({ message: "", id: 0, kind: "error" as NoticeKind });
  const setNotice = (message: string, kind: NoticeKind = "error") =>
    updateNotice((previous) => ({ message, kind, id: previous.id + 1 }));
  const [storage] = useState(() => {
    const storage = persister(ownerId);
    return {
      ...storage,
      persistClient: async (snapshot: Parameters<typeof storage.persistClient>[0]) => {
        try {
          await storage.persistClient(snapshot);
        } catch {
          setNotice(
            "No se pudo guardar la cola localmente. Mantén esta pestaña abierta y exporta tus borradores antes de salir.",
          );
        }
      },
    };
  });
  const [restored, setRestored] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    let unsubscribe = () => {};
    const unannounce = client.getMutationCache().subscribe((event) => {
      if (
        event.type !== "updated" ||
        (event.action.type !== "success" && event.action.type !== "error")
      )
        return;
      const state = event.mutation.state;
      setNotice(
        state.status === "success"
          ? savedNotice(state.data)
          : (state.error as Error | null)?.message || "Cambio pendiente de revisión.",
        state.status === "success" ? savedKind(state.data) : "error",
      );
    });
    void restoreRecovery()
      .then(async () => {
        const snapshot = await storage.restoreClient();
        return persistQueryClientRestore({
          queryClient: client,
          persister: { ...storage, restoreClient: async () => snapshot },
          buster: String(schemaVersion),
          maxAge: Infinity,
        });
      })
      .then(async () => {
        if (!alive) return;
        unsubscribe = persistQueryClientSubscribe({
          queryClient: client,
          persister: storage,
          buster: String(schemaVersion),
          dehydrateOptions: { shouldDehydrateMutation: (m) => m.state.status !== "success" },
        });
        const retainedEdits = Object.entries(recoverySnapshot())
          .filter(([key]) => key.startsWith("edit:"))
          .map(([, value]) => value as Edit)
          .sort((a, b) => a.order - b.order);
        for (const edit of retainedEdits) {
          if (
            client
              .getMutationCache()
              .getAll()
              .some((m) => (m.state.variables as Edit)?.id === edit.id)
          )
            continue;
          const mutation = client
            .getMutationCache()
            .build(client, { mutationKey: ["ordinary-edit"], scope: { id: edit.entity_id } });
          void mutation.execute(edit).catch(() => {});
        }
        setRestored(true);
        setRestoreError("");
        if (navigator.onLine) await resumeEdits(client);
      })
      .catch(() => {
        if (alive) {
          setRestoreError(
            "No se pudo restaurar la caché. Tus cambios conservados no se descartan.",
          );
        }
      });
    return () => {
      alive = false;
      unsubscribe();
      unannounce();
      client.clear();
    };
  }, [client, storage, restoreAttempt]);
  const clearLogout = async () => {
    const drafts = client
      .getMutationCache()
      .getAll()
      .filter((m) => m.state.status !== "success");
    const pendingResume = await stored(`resume-finalize:${ownerId}`, "get");
    if (
      (drafts.length || pendingResume || Object.keys(recoverySnapshot()).length) &&
      !window.confirm(
        `Hay ${drafts.length} cambios pendientes${pendingResume ? " y un CV sin finalizar" : ""}. ¿Descartarlos y cerrar sesión? Cancela para conservarlos o exportarlos.`,
      )
    )
      return;
    await clearRecovery();
    await storage.deactivate();
    client.clear();
    try {
      await logout();
    } catch {
      setNotice(
        "Sesión cerrada localmente. La desactivación remota de notificaciones queda pendiente.",
      );
    }
  };
  return (
    <QueryClientProvider client={client}>
      <Notice.Provider value={setNotice}>
        <Logout.Provider value={clearLogout}>
          {restored ? (
            <>
              <Reconcile client={client} storage={storage} />
              {children}
            </>
          ) : (
            <main aria-busy={!restoreError}>
              {restoreError || "Restaurando tus datos privados…"}
              {restoreError && (
                <>
                  <button onClick={() => setRestoreAttempt((n) => n + 1)}>
                    Reintentar restauración
                  </button>
                  <button onClick={() => downloadRecovery()}>Exportar recuperación</button>
                </>
              )}
            </main>
          )}
          <NoticeBanner
            key={notice.id}
            message={notice.message}
            kind={notice.kind}
            close={() =>
              updateNotice((current) =>
                current.id === notice.id ? { ...current, message: "" } : current,
              )
            }
          />
        </Logout.Provider>
      </Notice.Provider>
    </QueryClientProvider>
  );
}
function Reconcile({ client }: { client: QueryClient; storage: Persister }) {
  useEffect(() => {
    // Realtime events arrive in bursts (automation writes); refetch once per burst.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const catchup = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (navigator.onLine) {
          void resumeEdits(client);
          void client.invalidateQueries();
        }
      }, 250);
    };
    const visibility = () => {
      if (document.visibilityState === "visible") catchup();
    };
    window.addEventListener("online", catchup);
    document.addEventListener("visibilitychange", visibility);
    const channel = supabase?.channel(`crm:${ownerId}`);
    for (const table of [
      "jobs",
      "contacts",
      "companies",
      "outreach_events",
      "interviews",
      "crm_jobs",
      "sources",
      "resumes",
      "verifications",
    ])
      channel?.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `user_id=eq.${ownerId}` },
        catchup,
      );
    // A socket that drops and rejoins without an online/visibility event misses changes: catch up
    // when the channel rejoins (the first join follows a fresh load).
    let joined = false;
    channel?.subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      if (joined) catchup();
      joined = true;
    });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", catchup);
      document.removeEventListener("visibilitychange", visibility);
      if (channel) void supabase?.removeChannel(channel);
    };
  }, [client]);
  return null;
}
export function useRecords(name: string, input: Record<string, unknown> = {}) {
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: [name, input],
    queryFn: ({ pageParam }) =>
      operation<Page>(name, { ...input, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }),
    placeholderData: () => {
      if (name !== "jobs.list" || navigator.onLine || !input.sort) return undefined;
      const candidate = client
        .getQueriesData<{ pages: Page[]; pageParams: (string | null)[] }>({ queryKey: [name] })
        .find(([key, data]) => {
          const filters = (key[1] || {}) as Record<string, unknown>;
          const criteria = Object.keys(input).filter((k) => k !== "sort");
          return (
            data &&
            criteria.length === Object.keys(filters).filter((k) => k !== "sort").length &&
            criteria.every((k) => filters[k] === input[k])
          );
        })?.[1];
      if (!candidate) return undefined;
      const field = input.sort === "posted_desc" ? "posted_on" : "created_at";
      const rows = candidate.pages
        .flatMap((page) => page.items)
        .sort((a, b) => {
          if (a[field] == null && b[field] != null) return 1;
          if (b[field] == null && a[field] != null) return -1;
          return (
            (field === "created_at"
              ? Date.parse(String(b[field])) - Date.parse(String(a[field]))
              : String(b[field] ?? "").localeCompare(String(a[field] ?? ""))) ||
            b.id.localeCompare(a.id)
          );
        });
      let offset = 0;
      return {
        ...candidate,
        pages: candidate.pages.map((page) => {
          const items = rows.slice(offset, offset + page.items.length);
          offset += page.items.length;
          return { ...page, items };
        }),
      };
    },
    refetchInterval: (q) =>
      name === "jobs.list" &&
      q.state.data?.pages.some((page) =>
        page.items.some((record) => {
          const triage = record.triage as { state?: string } | null | undefined;
          return triage?.state === "queued" || triage?.state === "running";
        }),
      )
        ? 15000
        : false,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => (page.has_more ? page.next_cursor : undefined),
  });
  const edits = useEdits();
  const records = query.data?.pages.flatMap((page) => page.items) || [];
  const prefix = name.split(".")[0];
  return {
    ...query,
    hasNextPage: query.isPlaceholderData
      ? Boolean(query.data?.pages.at(-1)?.has_more)
      : query.hasNextPage,
    records: [
      ...records,
      ...edits
        .filter(
          (e) =>
            e.edit.operation === `${prefix}.upsert` ||
            (prefix === "outreach" && e.edit.operation === "outreach.draft"),
        )
        .filter((e) => !e.edit.input.id && !records.some((r) => r.id === e.edit.entity_id))
        .map((e) => ({ ...e.edit.input, id: e.edit.entity_id, version: 0, pending_local: true }))
        .filter((r) =>
          Object.entries(input).every(([key, value]) =>
            ["sort", "limit"].includes(key) || key === "query"
              ? key !== "query" ||
                JSON.stringify(r).toLowerCase().includes(String(value).toLowerCase())
              : r[key as keyof typeof r] === value,
          ),
        ),
    ].map((record) =>
      edits
        .filter((e) => e.edit.operation.startsWith(prefix + ".") && e.edit.entity_id === record.id)
        .reduce((r, e) => ({ ...r, ...e.edit.input, id: r.id, version: r.version }), record),
    ) as RecordData[],
    serverRecords: records,
  };
}
export function useRead<T>(name: string, input: Record<string, unknown> = {}) {
  return useQuery({
    queryKey: [name, input],
    queryFn: () => operation<T>(name, input),
    refetchInterval: (query) => {
      if (name === "automation.pack.get") {
        const data = query.state.data as any;
        return data?.preparation &&
          !data.preparation.paused &&
          ["queued", "running", "waiting"].includes(data.preparation.state) &&
          document.visibilityState === "visible" &&
          navigator.onLine
          ? 15000
          : false;
      }
      if (name === "dashboard.summary")
        return navigator.onLine && document.visibilityState !== "hidden" ? 60000 : false;
      const triage = (query.state.data as RecordData | undefined)?.triage as
        | { state?: string }
        | undefined;
      return name === "jobs.get" &&
        navigator.onLine &&
        document.visibilityState !== "hidden" &&
        ["queued", "running"].includes(triage?.state || "")
        ? 15000
        : false;
    },
  });
}
export function useLookupRecords(name: string, input: Record<string, unknown> = {}) {
  const query = useRecords(name, input);
  const { hasNextPage, isFetching, isError, fetchNextPage } = query;
  useEffect(() => {
    if (navigator.onLine && hasNextPage && !isFetching && !isError) void fetchNextPage();
  }, [hasNextPage, isFetching, isError, fetchNextPage]);
  return query;
}
export function useEdits() {
  return useMutationState({
    filters: { mutationKey: ["ordinary-edit"] },
    select: (m) => ({
      edit: m.state.variables as Edit,
      state: m.state.status,
      paused: m.state.isPaused,
      error: m.state.error as OperationError | null,
      mutation: m,
    }),
  })
    .filter((m) => m.edit && m.state !== "success")
    .sort((a, b) => a.edit.order - b.edit.order);
}
export function useEdit(entity: string) {
  const client = useQueryClient();
  const notice = useNotice();
  const mutation = useMutation<RecordData, Error, Edit>({
    mutationKey: ["ordinary-edit"],
    scope: { id: entity },
    onSuccess: (data) => notice(savedNotice(data), savedKind(data)),
    onError: (error) =>
      notice(error instanceof Error ? error.message : "Cambio pendiente de resolver."),
  });
  return async (name: string, input: Record<string, unknown>) => {
    const id = crypto.randomUUID();
    const values = { ...input, idempotency_key: id };
    try {
      parseOperation(name, values);
    } catch (error) {
      notice(error instanceof Error ? error.message : "Revisa los campos del formulario.");
      return false;
    }
    const order =
      Math.max(
        Date.now(),
        ...client
          .getMutationCache()
          .getAll()
          .map((m) => (m.state.variables as Edit)?.order || 0),
      ) + 1;
    const edit = { operation: name, entity_id: entity, input: values, id, order };
    try {
      await retainRecovery(`edit:${id}`, edit);
    } catch {
      notice("No se pudo guardar la solicitud. No se envió; conserva o exporta el borrador.");
      return false;
    }
    mutation.mutate(edit);
    if (!navigator.onLine)
      notice("Cambio en cola. Se guardará después de verificar tu sesión.", "info");
    return true;
  };
}
export type Intent = { name: string; input: Record<string, unknown> };
export function useExactWrite(scope: string) {
  const retained = useRetained<Intent>(`intent:${scope}`);
  const rejection = useRetained<{
    code: string;
    message: string;
    current_version?: number | undefined;
  }>(`rejection:${scope}`);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState("");
  const notice = useNotice();
  const client = useQueryClient();
  const send = async (request: Intent) => {
    if (busy.current) return null;
    const existing = recoverySnapshot()[`intent:${scope}`] as Intent | undefined;
    if (existing && JSON.stringify(existing) !== JSON.stringify(request)) {
      setError("Resuelve la solicitud original antes de cambiar su intención.");
      return null;
    }
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await retainRecovery(`intent:${scope}`, request);
      await retainRecovery(`rejection:${scope}`, null);
      const result = await operation(request.name, request.input);
      await retainRecovery(`intent:${scope}`, null);
      await retainRecovery(`rejection:${scope}`, null);
      notice("Solicitud confirmada. Revisa el resultado de los trabajos por separado.", "info");
      await client.invalidateQueries();
      return result;
    } catch (failure) {
      if (
        failure instanceof OperationError &&
        ["CONFLICT", "VALIDATION_ERROR", "BLOCKED"].includes(failure.code)
      ) {
        try {
          await retainRecovery(`rejection:${scope}`, {
            code: failure.code,
            message: failure.message,
            current_version: failure.current_version,
          });
        } catch {
          /* Original intent remains available. */
        }
      }
      setError(failure instanceof Error ? failure.message : "Resultado sin confirmar");
      return null;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return {
    intent: retained.value,
    confirmedConflict: rejection.value?.code === "CONFLICT",
    confirmedRejected: ["CONFLICT", "VALIDATION_ERROR", "BLOCKED"].includes(
      rejection.value?.code || "",
    ),
    rejection: rejection.value,
    discardRejected: async () => {
      if (!["CONFLICT", "VALIDATION_ERROR", "BLOCKED"].includes(rejection.value?.code || ""))
        return false;
      try {
        await retainRecovery(`intent:${scope}`, null);
        await retainRecovery(`rejection:${scope}`, null);
        setError("");
        return true;
      } catch {
        setError("No se pudo descartar la solicitud rechazada; se conserva.");
        return false;
      }
    },
    pending,
    error: error || retained.error,
    send,
    write: (name: string, input: Record<string, unknown>) =>
      retained.value
        ? Promise.resolve(null)
        : send({ name, input: { ...input, idempotency_key: crypto.randomUUID() } }),
    retry: () => (retained.value ? send(retained.value) : Promise.resolve(null)),
  };
}
export function useRestricted() {
  const notice = useNotice();
  const write = useExactWrite("restricted");
  return async (name: string, input: Record<string, unknown>, confirmation: string) => {
    if (!navigator.onLine) {
      notice("Esta acción requiere conexión.");
      return null;
    }
    if (write.intent) {
      notice("Resuelve la solicitud conservada antes de iniciar otra acción.");
      return null;
    }
    if (!window.confirm(confirmation)) return null;
    const result = await write.write(name, {
      ...input,
      ...(["companies.merge", "companies.archive"].includes(name) ? { confirmation: true } : {}),
    });
    if (!result)
      notice("Resultado sin confirmar. Conservamos la solicitud exacta para reintentar.");
    return result;
  };
}
export function RestrictedRecovery() {
  const write = useExactWrite("restricted");
  return write.intent ? (
    <section className="conflicts" aria-label="Solicitud pendiente">
      <p>Resultado sin confirmar: {write.intent.name}. La solicitud original se conserva.</p>
      {write.error && <p role="alert">{write.error}</p>}
      <button disabled={write.pending || !navigator.onLine} onClick={() => void write.retry()}>
        Reintentar solicitud original
      </button>
      {write.confirmedRejected && (
        <button onClick={() => void write.discardRejected()}>Descartar solicitud rechazada</button>
      )}
      <button onClick={downloadRecovery}>Exportar recuperación</button>
    </section>
  ) : null;
}
export function downloadRecovery() {
  const url = URL.createObjectURL(
    new Blob(
      [JSON.stringify({ schema_version: schemaVersion, recovery: recoverySnapshot() }, null, 2)],
      { type: "application/json" },
    ),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "crm-recuperacion.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function NoticeBanner({
  message,
  kind = "error",
  close,
}: {
  message: string;
  kind?: NoticeKind;
  close: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.visibilityState === "hidden");
  const remaining = useRef(6000);
  const transient = kind === "success" || kind === "info";
  useEffect(() => {
    if (!message || !transient || hovered || focused || hidden) return;
    const started = Date.now();
    const timer = setTimeout(close, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [message, transient, hovered, focused, hidden, close]);
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return (
    <div
      className="live"
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {message}
      {message && (
        <button aria-label="Cerrar aviso" onClick={close}>
          ×
        </button>
      )}
    </div>
  );
}
export function ConflictPanel() {
  const edits = useEdits();
  const client = useQueryClient();
  const notice = useNotice();
  const [current, setCurrent] = useState<Record<string, RecordData>>({});
  const conflicts = edits.filter((e) => e.state === "error");
  const resolve = async (entry: (typeof conflicts)[number]) => {
    if (!navigator.onLine) {
      notice("Conéctate para consultar la versión actual.");
      return;
    }
    try {
      const record = await findCurrent(entry.edit.operation, entry.edit.entity_id);
      if (!record) throw new Error("El registro ya no existe. Conserva o descarta el borrador.");
      setCurrent((c) => ({ ...c, [entry.edit.id]: record }));
    } catch (error) {
      notice(error instanceof Error ? error.message : "No se pudo consultar.");
    }
  };
  return conflicts.length ? (
    <section className="conflicts" aria-label="Cambios que necesitan revisión">
      <h2>Conservamos tus borradores</h2>
      <button onClick={() => exportDrafts(edits.map((e) => e.edit))}>
        Exportar cambios pendientes
      </button>
      {conflicts.map((entry) => (
        <article key={entry.edit.id}>
          <h3>
            {entry.error?.code === "BLOCKED" ? "Cambio dependiente pausado" : "Revisa este cambio"}
          </h3>
          <p>{entry.error?.message || "El servidor rechazó este cambio."}</p>
          <details>
            <summary>Tu borrador</summary>
            <pre>{JSON.stringify(entry.edit.input, null, 2)}</pre>
          </details>
          {current[entry.edit.id] && (
            <>
              <h4>Valor actual del servidor</h4>
              <pre>{JSON.stringify(current[entry.edit.id], null, 2)}</pre>
            </>
          )}
          <div className="actions">
            <button
              // Only an ambiguous outcome must stay (U02); a definitive failure can be discarded.
              disabled={
                !entry.error ||
                ["TEMPORARY_FAILURE", "IDEMPOTENCY_CONFLICT"].includes(entry.error.code)
              }
              onClick={async () => {
                try {
                  await retainRecovery(`edit:${entry.edit.id}`, null);
                } catch {
                  notice("No se pudo descartar localmente. El borrador se conserva.");
                  return;
                }
                client.getMutationCache().remove(entry.mutation as Mutation);
                void client.invalidateQueries();
              }}
            >
              Descartar este cambio
            </button>
            <button onClick={() => void resolve(entry)}>Consultar versión actual</button>
            <button
              disabled={!navigator.onLine}
              onClick={() => void (entry.mutation as Mutation).execute(entry.edit).catch(() => {})}
            >
              Reintentar solicitud original
            </button>
            {entry.error?.code === "CONFLICT" && current[entry.edit.id] && (
              <button
                onClick={async () => {
                  const id = crypto.randomUUID();
                  const input = {
                    ...entry.edit.input,
                    expected_version: current[entry.edit.id]?.version,
                    idempotency_key: id,
                  };
                  const next = { ...entry.edit, id, input };
                  try {
                    await replaceRecovery(`edit:${entry.edit.id}`, `edit:${id}`, next);
                  } catch {
                    notice("No se pudo guardar la reaplicación. El borrador original se conserva.");
                    return;
                  }
                  client.getMutationCache().remove(entry.mutation as Mutation);
                  const m = client.getMutationCache().build(client, {
                    mutationKey: ["ordinary-edit"],
                    scope: { id: entry.edit.entity_id },
                  });
                  void m.execute(next).catch(() => {});
                }}
              >
                Reaplicar explícitamente
              </button>
            )}
          </div>
        </article>
      ))}
    </section>
  ) : null;
}

export async function findCurrent(name: string, id: string): Promise<RecordData | undefined> {
  if (name.startsWith("jobs.")) return operation<RecordData>("jobs.get", { id });
  const list = name.startsWith("contacts.") ? "contacts.search" : `${name.split(".")[0]}.list`;
  let cursor: string | null = null;
  do {
    const page: Page = await operation<Page>(list, { limit: 50, ...(cursor ? { cursor } : {}) });
    const record = page.items.find((r) => r.id === id);
    if (record) return record;
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return undefined;
}

export function exportDrafts(edits: Edit[]) {
  const url = URL.createObjectURL(
    // Recovery holds unsent form fields, retained intents and receipts that logout would discard.
    new Blob(
      [
        JSON.stringify(
          { schema_version: schemaVersion, drafts: edits, recovery: recoverySnapshot() },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "crm-borradores-pendientes.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RecoveryStatus() {
  const health = useRetained<unknown>("__health");
  return health.error ? (
    <section role="alert" className="conflicts">
      <p>{health.error}</p>
      <button onClick={() => void health.retry()}>Reintentar almacenamiento</button>
      <button onClick={downloadRecovery}>Exportar recuperación</button>
    </section>
  ) : null;
}
