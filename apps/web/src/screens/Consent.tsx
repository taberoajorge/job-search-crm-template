import { useEffect, useState } from "react";
import type { OAuthAuthorizationDetails } from "@supabase/supabase-js";
import { requireSupabase, ownerId } from "../shared/api/client";
import { useNotice } from "../shared/state/crm";
import { agent } from "../shared/ui/controls";
export function consentRedirect(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("El destino de autorización no es seguro.");
  return url.href;
}
export function Consent() {
  const id = new URLSearchParams(location.search).get("authorization_id") || "";
  const [details, setDetails] = useState<OAuthAuthorizationDetails | null>(null);
  const [continuation, setContinuation] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const notice = useNotice();
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!navigator.onLine)
        throw new Error("Conéctate para revisar esta solicitud de autorización.");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
        throw new Error("Falta un identificador de autorización válido.");
      const { data, error } = await requireSupabase().auth.oauth.getAuthorizationDetails(id);
      if (error || !data)
        throw new Error("No se pudo consultar la solicitud. Puede haber expirado.");
      if (!alive) return;
      if ("authorization_id" in data) {
        if (
          data.authorization_id !== id ||
          data.user?.id !== ownerId ||
          typeof data.client?.name !== "string" ||
          typeof data.scope !== "string"
        )
          throw new Error("La solicitud no pertenece a tu cuenta.");
        consentRedirect(data.redirect_uri);
        setDetails(data);
      } else setContinuation(consentRedirect(data.redirect_url));
    };
    void load().catch((error) => {
      if (alive) setError(error instanceof Error ? error.message : "No se pudo consultar.");
    });
    return () => {
      alive = false;
    };
  }, [id, attempt]);
  const decide = async (approve: boolean) => {
    if (!navigator.onLine) {
      setError("Necesitas conexión para confirmar tu decisión.");
      return;
    }
    setBusy(true);
    try {
      const oauth = requireSupabase().auth.oauth;
      const { data, error } = await (approve
        ? oauth.approveAuthorization(id, { skipBrowserRedirect: true })
        : oauth.denyAuthorization(id, { skipBrowserRedirect: true }));
      if (error || !data?.redirect_url)
        throw new Error("No se pudo registrar la decisión. Reintenta.");
      notice(
        approve
          ? "Acceso autorizado. Regresando al cliente…"
          : "Acceso rechazado. Regresando al cliente…",
      );
      location.assign(consentRedirect(data.redirect_url));
    } catch (error) {
      setError(error instanceof Error ? error.message : "No se pudo completar.");
      setBusy(false);
    }
  };
  return (
    <section className="card consent">
      <p className="eyebrow">CONEXIÓN PRIVADA · MCP</p>
      <h1>Autorizar un cliente</h1>
      <p>Revisa quién solicita acceso a tu CRM. Esta decisión solo puede tomarla su propietario.</p>
      {error && (
        <p role="alert">
          {error}
          <button
            onClick={() => {
              setError("");
              setAttempt((n) => n + 1);
            }}
          >
            Reintentar consulta
          </button>
        </p>
      )}
      {details ? (
        <>
          <h2>{details.client.name}</h2>
          <p>Cliente: {details.client.id}</p>
          <p>Permisos solicitados: {details.scope}</p>
          <p>Destino registrado: {details.redirect_uri}</p>
          <p>
            El cliente autorizado podrá usar tus operaciones CRM dentro de los permisos del
            propietario. No se enviarán aplicaciones ni mensajes automáticamente.
          </p>
          <div className="actions">
            <button
              {...agent("oauth", id, "approve")}
              className="primary"
              disabled={busy || !navigator.onLine}
              onClick={() => void decide(true)}
            >
              Autorizar acceso
            </button>
            <button
              {...agent("oauth", id, "deny")}
              disabled={busy || !navigator.onLine}
              onClick={() => void decide(false)}
            >
              Rechazar acceso
            </button>
          </div>
        </>
      ) : continuation ? (
        <>
          <p>Este cliente ya cuenta con tu autorización.</p>
          <button onClick={() => location.assign(continuation)}>Continuar con el cliente</button>
        </>
      ) : !error ? (
        <p role="status">Consultando solicitud…</p>
      ) : null}
    </section>
  );
}
