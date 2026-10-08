import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { Notifications, NotificationEntry } from "../screens/Notifications";
import { Dashboard } from "../screens/Dashboard";
import { notifyManager, useQueryClient } from "@tanstack/react-query";
import { ConflictPanel, RestrictedRecovery, RecoveryStatus, useEdits } from "../shared/state/crm";
const Automation = lazy(() =>
  import("../screens/Automation").then((module) => ({ default: module.Automation })),
);
const Consent = lazy(() =>
  import("../screens/Consent").then((module) => ({ default: module.Consent })),
);
const Pipeline = lazy(() =>
  import("../screens/Pipeline").then((module) => ({ default: module.Pipeline })),
);
const JobDetail = lazy(() =>
  import("../screens/JobDetail").then((module) => ({ default: module.JobDetail })),
);
const Contacts = lazy(() =>
  import("../screens/Contacts").then((module) => ({ default: module.Contacts })),
);
const Outreach = lazy(() =>
  import("../screens/Outreach").then((module) => ({ default: module.Outreach })),
);
const Interviews = lazy(() =>
  import("../screens/Interviews").then((module) => ({ default: module.Interviews })),
);
const Resumes = lazy(() =>
  import("../screens/Resumes").then((module) => ({ default: module.Resumes })),
);
const Settings = lazy(() =>
  import("../screens/Settings").then((module) => ({ default: module.Settings })),
);
const screens = [
  ["dashboard", "Inicio", "⌂"],
  ["pipeline", "Pipeline", "▤"],
  ["contacts", "Contactos", "♧"],
  ["outreach", "Mensajes", "↗"],
  ["interviews", "Entrevistas", "◷"],
  ["resumes", "CVs", "▧"],
  ["settings", "Ajustes", "⚙"],
  ["automation", "Automatización", "⟳"],
] as const;
const sidebarPaths: Record<string, string> = {
  dashboard: "M3 10 12 3l9 7v11h-6v-7H9v7H3Z",
  pipeline: "M3 3h18v18H3ZM9 3v18M15 3v18",
  contacts:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  outreach: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l2-5.5a8.5 8.5 0 1 1 16-3Z",
  interviews: "M3 5h18v16H3ZM16 3v4M8 3v4M3 11h18",
  resumes: "M14 2H4v20h16V8ZM14 2v6h6M8 13h8M8 17h8",
  settings:
    "M10 2h4l1 3 2 1 3-1 2 4-2 2v2l2 2-2 4-3-1-2 1-1 3h-4l-1-3-2-1-3 1-2-4 2-2v-2L2 9l2-4 3 1 2-1ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  automation: "M20 7h-6V1M4 17h6v6M20 7a9 9 0 0 0-15-2M4 17a9 9 0 0 0 15 2",
};
export function App() {
  const [screen, setScreen] = useState(() => screenFor(new URLSearchParams(location.search)));
  const [job, setJob] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("job"),
  );
  const [company, setCompany] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("company"),
  );
  const [detailTarget, setDetailTarget] = useState(() => ({
    section: new URLSearchParams(location.search).get("section"),
    notification: new URLSearchParams(location.search).get("notification"),
  }));
  const [collapsed, setCollapsed] = useState(false);
  const more = useRef<HTMLDialogElement>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const client = useQueryClient();
  const navigate = (value: string, id?: string, section?: string, companyId?: string) => {
    more.current?.close();
    setScreen(value);
    setJob(id || null);
    setCompany(companyId || null);
    const url = new URL(location.href);
    url.searchParams.set("screen", value);
    if (id) url.searchParams.set("job", id);
    else url.searchParams.delete("job");
    if (section) url.searchParams.set("section", section);
    else url.searchParams.delete("section");
    if (companyId) url.searchParams.set("company", companyId);
    else url.searchParams.delete("company");
    url.searchParams.delete("notification");
    setDetailTarget({ section: section ?? null, notification: null });
    history.pushState({}, "", url);
    const content = document.getElementById("main-content");
    content?.scrollTo(0, 0);
    content?.focus();
  };
  // Filters are not destinations: replace the history entry instead of pushing one.
  const filterCompany = (value: string | null) => {
    setCompany(value);
    const url = new URL(location.href);
    if (value) url.searchParams.set("company", value);
    else url.searchParams.delete("company");
    history.replaceState(history.state, "", url);
  };
  useEffect(() => {
    const stopDismiss = dismissDialogs();
    const connection = () => setOnline(navigator.onLine);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    const pop = () => {
      const p = new URLSearchParams(location.search);
      setScreen(screenFor(p));
      setJob(p.get("job"));
      setCompany(p.get("company"));
      setDetailTarget({ section: p.get("section"), notification: p.get("notification") });
    };
    window.addEventListener("popstate", pop);
    const message = (event: MessageEvent) => {
      if (event.data?.type === "crm-task-completed") {
        navigate("settings");
        void client.invalidateQueries();
      }
    };
    navigator.serviceWorker?.addEventListener("message", message);
    return () => {
      stopDismiss();
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
      window.removeEventListener("popstate", pop);
      navigator.serviceWorker?.removeEventListener("message", message);
    };
  }, [client]);
  return (
    <div className={`layout${collapsed ? " sidebar-collapsed" : ""}`}>
      <a className="skip" href="#main-content">
        Saltar al contenido
      </a>
      <aside className="sidebar" id="desktop-sidebar">
        <div className="sidebar-head">
          <button
            className="sidebar-toggle"
            aria-label={collapsed ? "Expandir navegación" : "Contraer navegación"}
            aria-expanded={!collapsed}
            aria-controls="desktop-sidebar-nav"
            onClick={() => setCollapsed(!collapsed)}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <a className="brand" href="/?screen=dashboard" aria-label="Job Search CRM · Inicio">
            Job Search CRM
          </a>
        </div>
        <nav id="desktop-sidebar-nav" aria-label="Navegación principal">
          {screens.map(([id, label]) => (
            <button
              key={id}
              aria-label={label}
              title={collapsed ? label : undefined}
              aria-current={screen === id ? "page" : undefined}
              data-agent-action={`navigate-${id}`}
              onClick={() => navigate(id)}
            >
              <span aria-hidden="true" className="sidebar-icon">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={sidebarPaths[id]} />
                </svg>
              </span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>Job Search CRM</span>
          <NotificationEntry open={() => navigate("notifications")} />
          <ConnectionStatus online={online} />
        </header>
        <main id="main-content" tabIndex={-1}>
          <SyncStatus online={online} />
          <RecoveryStatus />
          <ConflictPanel />
          <RestrictedRecovery />
          <ScreenBoundary key={`${screen}:${job}`}>
            <Suspense fallback={<p role="status">Cargando pantalla…</p>}>
              {location.pathname === "/oauth/consent" ? (
                <Consent />
              ) : job ? (
                <JobDetail
                  key={`${job}:${detailTarget.section}:${detailTarget.notification}`}
                  id={job}
                  initialSection={detailTarget.section}
                  notificationId={detailTarget.notification}
                  back={() => navigate("pipeline", undefined, undefined, company ?? undefined)}
                  backHref={`/?screen=pipeline${company ? `&company=${encodeURIComponent(company)}` : ""}`}
                />
              ) : screen === "notifications" ? (
                <Notifications />
              ) : screen === "pipeline" ? (
                <Pipeline
                  open={(id) => navigate("pipeline", id, undefined, company ?? undefined)}
                  company={company}
                  onCompanyChange={filterCompany}
                />
              ) : screen === "contacts" ? (
                <Contacts navigate={navigate} />
              ) : screen === "outreach" ? (
                <Outreach />
              ) : screen === "interviews" ? (
                <Interviews />
              ) : screen === "resumes" ? (
                <Resumes />
              ) : screen === "automation" ? (
                <Automation />
              ) : screen === "settings" ? (
                <Settings />
              ) : (
                <Dashboard navigate={(value, section, job) => navigate(value, job, section)} />
              )}
            </Suspense>
          </ScreenBoundary>
        </main>
        <footer>
          Job Search CRM <span>Espacio personal</span>
        </footer>
      </div>
      <nav className="dock" aria-label="Navegación móvil">
        {screens.slice(0, 3).map(([id, label, icon]) => (
          <button
            key={id}
            aria-current={screen === id ? "page" : undefined}
            aria-label={label}
            onClick={() => navigate(id)}
          >
            <span aria-hidden="true">{icon}</span>
            <small>{label}</small>
          </button>
        ))}
        <button
          aria-label="Más"
          aria-current={
            !screens.slice(0, 3).some(([id]) => id === screen) && screen !== "notifications"
              ? "page"
              : undefined
          }
          onClick={() => more.current?.showModal()}
        >
          <span aria-hidden="true">☰</span>
          <small>Más</small>
        </button>
      </nav>
      <dialog ref={more} aria-label="Más secciones" className="navigation-menu">
        <div className="dialog-head">
          <h2>Más secciones</h2>
          <button aria-label="Cerrar navegación" onClick={() => more.current?.close()}>
            ×
          </button>
        </div>
        <nav aria-label="Otras secciones">
          {screens.slice(3).map(([id, label, icon]) => (
            <button
              key={id}
              aria-current={screen === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <span aria-hidden="true">{icon}</span> {label}
            </button>
          ))}
        </nav>
      </dialog>
    </div>
  );
}
export function ConnectionStatus({ online }: { online: boolean }) {
  const client = useQueryClient();
  const [backend, setBackend] = useState("Sincronización sin confirmar");
  useEffect(() => {
    const update = () => {
      const queries = client
        .getQueryCache()
        .getAll()
        .filter((query) => query.getObserversCount() > 0);
      const last = Math.max(0, ...queries.map((query) => query.state.dataUpdatedAt));
      setBackend(
        queries.some((query) => query.state.status === "error")
          ? "Hay errores al consultar datos"
          : queries.some((query) => query.state.fetchStatus === "fetching")
            ? "Sincronizando datos…"
            : last
              ? `Datos actualizados ${new Date(last).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}`
              : "Sincronización sin confirmar",
      );
    };
    update();
    // The cache notifies synchronously when a screen builds a query during render; defer the
    // state update the way TanStack's own hooks do.
    return client.getQueryCache().subscribe(notifyManager.batchCalls(update));
  }, [client]);
  return (
    <span className="connection">
      <i aria-hidden="true" className={online ? "online" : "offline"} />
      <span>
        {online ? "Red disponible" : "Sin red"}
        <small>{online ? backend : "Cambios guardados en este dispositivo"}</small>
      </span>
    </span>
  );
}
export function SyncStatus({ online }: { online: boolean }) {
  const edits = useEdits();
  const client = useQueryClient();
  const [last, setLast] = useState(0);
  useEffect(
    () =>
      client.getQueryCache().subscribe(
        notifyManager.batchCalls(() =>
          setLast(
            Math.max(
              0,
              ...client
                .getQueryCache()
                .getAll()
                .map((q) => q.state.dataUpdatedAt),
            ),
          ),
        ),
      ),
    [client],
  );
  return !online || edits.length > 0 ? (
    <div className="sync" role="status">
      {online ? "Cambios pendientes" : "Modo sin conexión"} · {edits.length} cambios · Última
      sincronización: {last ? new Date(last).toLocaleString("es-MX") : "sin datos guardados"}
    </div>
  ) : null;
}

class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert">
        <p>No se pudo cargar esta pantalla. Los borradores conservados siguen disponibles.</p>
        <button onClick={() => location.reload()}>Reintentar pantalla</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
// Close a modal only for a genuine backdrop click: a drag that starts inside the dialog (for
// example selecting text) and ends on the backdrop also reports the dialog as its click target.
export function dismissDialogs() {
  let pressedOutside = false;
  const outside = (event: MouseEvent) => {
    const dialog = event.target;
    if (!(dialog instanceof HTMLDialogElement) || !dialog.open) return false;
    const bounds = dialog.getBoundingClientRect();
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );
  };
  const press = (event: PointerEvent) => {
    pressedOutside = outside(event);
  };
  const dismiss = (event: MouseEvent) => {
    if (pressedOutside && outside(event)) (event.target as HTMLDialogElement).close();
    pressedOutside = false;
  };
  document.addEventListener("pointerdown", press);
  document.addEventListener("click", dismiss);
  return () => {
    document.removeEventListener("pointerdown", press);
    document.removeEventListener("click", dismiss);
  };
}
// Task-completion emails link to /?task=<id>; that task lives in Settings.
function screenFor(params: URLSearchParams) {
  return params.get("screen") || (params.has("task") ? "settings" : "dashboard");
}
