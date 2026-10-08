import { parseOperation } from "@crm/contracts";
import { stored } from "../state/storage";
import { onlineOnly, ownerId, requireSupabase } from "./client";
export async function checksum(file: Blob) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
export async function uploadResume(
  file: File,
  metadata: { label: string; country: string | null; track: string | null },
) {
  onlineOnly();
  const pending = await pendingResume();
  const client = requireSupabase();
  const types = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  if (!types.includes(file.type) || file.size > 10 * 1024 * 1024 || !file.size)
    throw new Error("Selecciona un PDF o DOCX válido, de hasta 10 MB.");
  const hash = await checksum(file);
  if (pending && pending.checksum !== hash)
    throw new Error("Selecciona el mismo archivo para recuperar el CV pendiente.");
  const storage_path = pending
    ? String(pending.storage_path)
    : `${ownerId}/${crypto.randomUUID()}/resume.${file.type === "application/pdf" ? "pdf" : "docx"}`;
  const input = pending ?? {
    ...metadata,
    storage_path,
    checksum: hash,
    media_type: file.type,
    active: true,
    idempotency_key: crypto.randomUUID(),
  };
  // Invalid metadata must fail here: once reserved, the receipt is replayed unchanged.
  if (!pending)
    try {
      parseOperation("resumes.finalize", input);
    } catch (failure) {
      const field = String(
        (failure as { issues?: { path: PropertyKey[] }[] }).issues?.[0]?.path[0],
      );
      const names: Record<string, string> = {
        label: "nombre de la versión",
        country: "país",
        track: "enfoque profesional",
      };
      throw new Error(
        `Revisa el ${names[field] ?? "dato"} del CV (por ejemplo, de 1 a 500 caracteres).`,
      );
    }
  // Reserve identity before sending bytes; no private bytes are persisted.
  await stored(`resume-finalize:${ownerId}`, "put", input);
  if (pending) {
    const existing = await client.storage.from("resumes").download(storage_path);
    if (existing.data) {
      if ((await checksum(existing.data)) !== hash)
        throw new Error("El archivo remoto no coincide. Conservamos el recibo para revisión.");
      return retryResumeFinalize();
    }
    if (
      String(
        (existing.error as { status?: number; statusCode?: string } | null)?.statusCode ??
          (existing.error as { status?: number } | null)?.status,
      ) !== "404"
    )
      throw new Error("No se pudo verificar el archivo pendiente. Reintenta con conexión.");
  }
  const { error } = await client.storage
    .from("resumes")
    .upload(storage_path, file, { upsert: false, contentType: file.type });
  if (error)
    throw new Error(
      "Subida sin confirmar. Conservamos la ruta y el recibo; recupera la finalización o selecciona el mismo archivo.",
    );
  return retryResumeFinalize();
}
export async function fetchResume(id: string, signal?: AbortSignal) {
  onlineOnly();
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke("crm", {
    body: { operation: "resumes.get_download", input: { id } },
  });
  if (error || data?.error) throw new Error("No se pudo preparar la descarga privada.");
  const url = data?.url || data?.signed_url || data?.result?.url;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url))
    throw new Error("Respuesta de descarga inválida.");
  // Download URLs are transient: never enter query cache, DOM payload or persistent state.
  const response = await fetch(url, { signal: signal ?? null });
  if (!response.ok) throw new Error("La descarga expiró. Solicítala de nuevo.");
  return response.blob();
}
export async function downloadResume(id: string) {
  const blob = await fetchResume(id);
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = "curriculum";
  a.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

// Explicit owner choice after a rejected finalization; the uploaded object needs backend cleanup.
export function discardPendingResume() {
  return stored(`resume-finalize:${ownerId}`, "delete");
}
export function pendingResume() {
  return stored<Record<string, unknown>>(`resume-finalize:${ownerId}`, "get");
}
export async function retryResumeFinalize() {
  onlineOnly();
  const input = await pendingResume();
  if (!input) throw new Error("No hay finalización pendiente.");
  const { data, error } = await requireSupabase().functions.invoke("crm", {
    body: { operation: "resumes.finalize", input },
  });
  if (error || data?.error)
    throw new Error(
      data?.error?.message ||
        "No se pudo verificar y finalizar el CV. El archivo y su recibo siguen pendientes.",
    );
  const result = data;
  await stored(`resume-finalize:${ownerId}`, "delete");
  return result;
}
