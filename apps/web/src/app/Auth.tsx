import { useEffect, useState, type ReactNode } from "react";
import {
  configured,
  ownerId,
  setAuthorized,
  supabase,
  operation,
  requireSupabase,
} from "../shared/api/client";
import { namespace, stored } from "../shared/state/storage";
import { CrmProvider } from "../shared/state/crm";

function SessionLoading({ error, retry }: { error?: string; retry?: () => void }) {
  return (
    <main className="session-loading" aria-busy={!error}>
      <div className="brand">Job Search CRM</div>
      <h1>Tu espacio de trabajo</h1>
      <p role={error ? "alert" : "status"}>{error || "Verificando tu sesión…"}</p>
      {error ? (
        <button className="primary" onClick={retry}>
          Reintentar verificación
        </button>
      ) : (
        <div className="session-skeleton" aria-hidden="true">
          <div />
          <div />
          <div />
        </div>
      )}
    </main>
  );
}

export function Auth({
  children,
  identityControls,
  identityLogout,
  identityPending = false,
  identitySignedIn = false,
}: {
  children: ReactNode;
  identityControls?: ReactNode;
  identityLogout?: () => Promise<unknown>;
  identityPending?: boolean;
  identitySignedIn?: boolean;
}) {
  const [state, setState] = useState<
    "checking" | "signedout" | "authorized" | "forbidden" | "unavailable"
  >(configured ? "checking" : "signedout");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    let generation = 0;
    let verified = false;
    const verify = async (current: number) => {
      setAuthorized(false);
      const {
        data: { session },
        error: sessionError,
      } = await requireSupabase().auth.getSession();
      if (sessionError) throw sessionError;
      let allowed = false;
      if (session && session.user.id === ownerId && (session.expires_at || 0) > Date.now() / 1000) {
        if (navigator.onLine) {
          const { data, error } = await requireSupabase().auth.getUser();
          if (error && error.status !== 401 && error.status !== 403) throw error;
          allowed = !error && data.user?.id === ownerId;
          if (allowed) await stored(namespace(ownerId) + ":verified", "put", true);
        } else allowed = Boolean(await stored(namespace(ownerId) + ":verified", "get"));
      }
      if (!alive || current !== generation) return;
      verified = allowed;
      setAuthorized(allowed);
      if (allowed && navigator.onLine) {
        const cleanup = await stored<string | { endpoint: string; idempotency_key: string }>(
          namespace(ownerId) + ":push-cleanup",
          "get",
        );
        if (cleanup)
          try {
            const input =
              typeof cleanup === "string"
                ? { endpoint: cleanup, idempotency_key: crypto.randomUUID() }
                : cleanup;
            await stored(namespace(ownerId) + ":push-cleanup", "put", input);
            await operation("push.deactivate", input);
            await stored(namespace(ownerId) + ":push-cleanup", "delete");
          } catch {
            setError("Desactivación anterior de notificaciones pendiente.");
          }
      }
      if (alive && current === generation)
        setState(allowed ? "authorized" : session ? "forbidden" : "signedout");
    };
    const start = () => {
      if (!alive) return;
      const current = ++generation;
      void verify(current).catch(() => {
        if (alive && current === generation) {
          setState("unavailable");
          setError("No se pudo verificar tu sesión. Comprueba la conexión e intenta nuevamente.");
        }
      });
    };
    start();
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      // start() already reads the initialized session; don't duplicate its backend request.
      if (event === "INITIAL_SESSION") return;
      // Token refreshes and the SIGNED_IN emitted on every tab refocus keep the verified owner;
      // re-verifying would de-authorize in-flight edits and tear down the workspace on a blip.
      if (
        verified &&
        (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") &&
        session?.user.id === ownerId
      )
        return;
      setTimeout(start, 0);
    });
    window.addEventListener("online", start);
    return () => {
      alive = false;
      generation++;
      data.subscription.unsubscribe();
      window.removeEventListener("online", start);
      setAuthorized(false);
    };
  }, [attempt]);
  // discardPending: the CRM logout already confirmed discarding drafts. "Cambiar de cuenta" on the
  // forbidden screen did not, so it keeps the owner's pending CV receipt for their return.
  const logout = async (discardPending = true) => {
    if (!supabase) return;
    const registration = await navigator.serviceWorker?.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      const input = { endpoint: subscription.endpoint, idempotency_key: crypto.randomUUID() };
      await stored(namespace(ownerId) + ":push-cleanup", "put", input);
      if (navigator.onLine)
        try {
          await operation("push.deactivate", input);
          await stored(namespace(ownerId) + ":push-cleanup", "delete");
        } catch {
          setError("Desactivación remota pendiente.");
        }
      try {
        await subscription.unsubscribe();
      } catch {
        /* Durable cleanup is retried after owner verification. */
      }
    }
    await stored(namespace(ownerId) + ":verified", "delete");
    if (discardPending) {
      await stored(`resume-finalize:${ownerId}`, "delete");
      // An uncertain push.subscribe intent carries the subscription keys; only the opaque
      // deactivation cleanup may outlive logout.
      const push = await stored<{ operation?: string }>(`push-intent:${ownerId}`, "get");
      if (push?.operation === "push.subscribe") await stored(`push-intent:${ownerId}`, "delete");
    }
    setAuthorized(false);
    if (navigator.onLine)
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        /* Local logout still clears auth state. */
      }
    try {
      for (const key of Object.keys(localStorage))
        if (key === "crm-auth" || key.startsWith("crm-auth-")) localStorage.removeItem(key);
    } catch {
      setError(
        "El navegador bloqueó la limpieza del almacenamiento. La sesión permanece oculta; revisa el acceso antes de salir.",
      );
    }
    setState("signedout");
    if (identityLogout) {
      try {
        await identityLogout();
      } catch {
        setError("La sesión local se cerró; verifica tu acceso cuando recuperes la conexión.");
      }
    }
    if (!navigator.onLine) window.location.reload();
  };
  if (state === "authorized") return <CrmProvider logout={logout}>{children}</CrmProvider>;
  if (state === "unavailable")
    return (
      <SessionLoading
        error={error}
        retry={() => {
          setError("");
          setState("checking");
          setAttempt((value) => value + 1);
        }}
      />
    );
  if (state === "checking" || (configured && state === "signedout" && identityPending))
    return <SessionLoading />;
  if (state === "signedout" && identitySignedIn)
    return (
      <main className="auth auth-owner">
        <div className="brand">Job Search CRM</div>
        <h1>Tu espacio de trabajo</h1>
        {identityControls}
        <p role="status">{error}</p>
      </main>
    );
  return (
    <main className="auth">
      <div className="brand">
        B<span>rújula</span>
      </div>
      <p className="eyebrow">TU SIGUIENTE PASO, CON CLARIDAD</p>
      <h1>
        Tu búsqueda.
        <br />
        En un solo lugar.
      </h1>
      <p>Un espacio privado para oportunidades, conversaciones y lo que sigue.</p>
      {!configured ? (
        <>
          <p role="alert">
            Falta configurar la conexión y el propietario. Consulta la configuración del proyecto.
          </p>
          {identityControls}
        </>
      ) : state === "forbidden" ? (
        <>
          <p role="alert">Esta cuenta no tiene acceso, o su sesión necesita verificación online.</p>
          <button onClick={() => void logout(false)}>Cambiar de cuenta</button>
        </>
      ) : (
        identityControls || (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const email = new FormData(event.currentTarget).get("email") as string;
              const { error } = await requireSupabase().auth.signInWithOtp({
                email,
                options: {
                  emailRedirectTo:
                    window.location.origin + window.location.pathname + window.location.search,
                  shouldCreateUser: false,
                },
              });
              setError(error ? error.message : "Revisa tu correo para iniciar sesión.");
            }}
          >
            <label>
              Correo de tu cuenta
              <input type="email" name="email" autoComplete="email" required />
            </label>
            <button className="primary">Recibir enlace de acceso</button>
          </form>
        )
      )}
      <p role="status">{error}</p>
    </main>
  );
}
