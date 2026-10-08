import { parseOperation } from "@crm/contracts";
import { onlineManager } from "@tanstack/react-query";
import { createClient } from "@supabase/supabase-js";
export const ownerId = String(import.meta.env.VITE_OWNER_ID || "");
const url = String(import.meta.env.VITE_SUPABASE_URL || "");
const key = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "");
let safeConfiguration = false;
try {
  const origin = new URL(url);
  safeConfiguration =
    ["http:", "https:"].includes(origin.protocol) &&
    !origin.username &&
    !origin.password &&
    !key.startsWith("sb_secret_");
  if (key.split(".").length === 3) {
    const payload = key.split(".")[1] || "";
    safeConfiguration &&=
      JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).role === "anon";
  }
} catch {
  /* Invalid project configuration cannot create an authenticated client. */
}
export const configured = Boolean(
  safeConfiguration &&
  url &&
  key &&
  ownerId &&
  /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(ownerId),
);
export const supabase = configured
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: "crm-auth",
      },
    })
  : null;
export function requireSupabase() {
  if (!supabase) throw new Error("Falta configurar Supabase.");
  return supabase;
}
export type RecordData = { id: string; version: number; [key: string]: unknown };
export type Page = { items: RecordData[]; next_cursor: string | null; has_more: boolean };
export class OperationError extends Error {
  constructor(
    public code: string,
    message: string,
    public current?: RecordData,
    public field?: string,
    public current_version?: number,
    public retryable?: boolean,
  ) {
    const messages: Record<string, string> = {
      CONFLICT:
        "El registro cambió desde que empezaste. Conservamos tu borrador y su versión original; revisa la versión actual antes de reaplicar.",
      IDEMPOTENCY_CONFLICT:
        "La identidad de esta solicitud corresponde a otro contenido. Conservamos la solicitud; necesita revisión antes de crear otro cambio.",
      TEMPORARY_FAILURE:
        "No se pudo confirmar el resultado. Reintenta la solicitud original con conexión.",
      UNAUTHENTICATED: "Verifica tu sesión para continuar. Tus borradores se conservan.",
      FORBIDDEN: "Esta cuenta no tiene permiso para esta operación.",
      NOT_FOUND: "El registro solicitado no está disponible.",
    };
    super(messages[code] || message);
  }
}
let authorized = false;
export function setAuthorized(value: boolean) {
  authorized = value;
  onlineManager.setOnline(value && navigator.onLine);
}
export async function operation<T = RecordData>(
  name: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  if (!supabase || !authorized)
    throw new OperationError("UNAUTHENTICATED", "Inicia sesión con la cuenta autorizada.");
  const { data, error } = await supabase.rpc("crm_operation", {
    p_operation: name,
    p_input: parseOperation(name, input),
  });
  if (error) {
    let detail: { code?: string; message?: string; current?: RecordData } = {};
    try {
      detail = JSON.parse(error.details || error.message);
    } catch {
      /* PostgREST may return plain text. */
    }
    throw new OperationError(
      detail.code || "TEMPORARY_FAILURE",
      detail.message || error.message,
      detail.current,
      (detail as { field?: string }).field,
      (detail as { current_version?: number }).current_version,
      (detail as { retryable?: boolean }).retryable,
    );
  }
  if (data?.error || data?.isError) {
    const detail = data.error || data;
    throw new OperationError(
      detail.code,
      detail.message || "No se pudo completar la operación.",
      detail.current,
      (detail as { field?: string }).field,
      (detail as { current_version?: number }).current_version,
      (detail as { retryable?: boolean }).retryable,
    );
  }
  validateResponse(data);
  return data as T;
}
export function onlineOnly() {
  if (!navigator.onLine)
    throw new OperationError("OFFLINE", "Esta acción necesita conexión y confirmación.");
}

export function validateResponse(data: unknown): void {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new OperationError("TEMPORARY_FAILURE", "Respuesta del servidor inválida.");
  const record = data as Record<string, unknown>;
  if ("items" in record) {
    if (
      !Array.isArray(record.items) ||
      typeof record.has_more !== "boolean" ||
      !(record.next_cursor === null || typeof record.next_cursor === "string")
    )
      throw new OperationError("TEMPORARY_FAILURE", "Página del servidor inválida.");
    for (const item of record.items) validateResponse(item);
  }
  if (
    "id" in record &&
    (typeof record.id !== "string" || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(record.id))
  )
    throw new OperationError("TEMPORARY_FAILURE", "Identificador inválido del servidor.");
  if ("version" in record && (!Number.isSafeInteger(record.version) || Number(record.version) < 1))
    throw new OperationError("TEMPORARY_FAILURE", "Versión inválida del servidor.");
  if ("user_id" in record && record.user_id !== ownerId)
    throw new OperationError("FORBIDDEN", "El servidor devolvió un registro de otra cuenta.");
}
