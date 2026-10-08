import { onlineOnly, operation, ownerId, requireSupabase } from "./client";
import { stored } from "../state/storage";

type PushIntent = { operation: string; input: Record<string, unknown> };
const pendingKey = `push-intent:${ownerId}`;
let activating = false;
export async function subscribePush() {
  if (activating) throw new Error("La activación ya está en curso.");
  activating = true;
  try {
    await activatePush();
  } finally {
    activating = false;
  }
}
async function activatePush() {
  onlineOnly();
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    throw new Error(
      "Este navegador no admite notificaciones push. En iOS, instala primero la app en la pantalla de inicio.",
    );
  // Permission stays attached to this explicit user gesture; retries never prompt again.
  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
  if (permission !== "granted")
    throw new Error(
      "Notificaciones no autorizadas. Actívalas en los permisos del navegador; los resultados siguen disponibles aquí.",
    );
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { data, error } = await requireSupabase().functions.invoke("push", { method: "GET" });
  if (error) {
    const status = (error.context as Response | undefined)?.status;
    throw new Error(
      status === 401 || status === 403
        ? "No se pudo verificar la sesión para notificaciones. Inicia sesión nuevamente."
        : status
          ? "La configuración de notificaciones no está disponible. Intenta nuevamente."
          : "No se pudo conectar al servicio de notificaciones. Revisa la conexión e intenta nuevamente.",
    );
  }
  const bytes = publicPushKey(data?.public_key);
  let subscription = await registration.pushManager.getSubscription();
  const pending = await stored<PushIntent>(pendingKey, "get");
  if (pending) {
    await resolveIntent(pending);
    if (
      pending.operation === "push.subscribe" &&
      subscription &&
      pending.input.endpoint === subscription.endpoint &&
      subscription.options.applicationServerKey &&
      sameKey(new Uint8Array(subscription.options.applicationServerKey), bytes)
    )
      return;
  }
  if (
    subscription &&
    subscription.options.applicationServerKey &&
    !sameKey(new Uint8Array(subscription.options.applicationServerKey), bytes)
  ) {
    await pushMutation("push.deactivate", { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
    subscription = null;
  }
  try {
    subscription ||= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytes,
    });
  } catch {
    throw new Error(
      "El navegador no pudo crear la suscripción. Revisa los permisos e intenta nuevamente.",
    );
  }
  const json = subscription.toJSON();
  await pushMutation("push.subscribe", {
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth,
    device_label: navigator.userAgent.slice(0, 100),
  });
}
export function publicPushKey(value: unknown) {
  try {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(value)) throw new Error();
    const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) =>
      c.charCodeAt(0),
    );
    if (bytes.length !== 65 || bytes[0] !== 4) throw new Error();
    return bytes;
  } catch {
    throw new Error(
      "La clave pública de notificaciones es inválida o no está configurada. Intenta nuevamente cuando se corrija el servicio.",
    );
  }
}
async function resolveIntent(intent: PushIntent) {
  try {
    await operation(intent.operation, intent.input);
    await stored(pendingKey, "delete");
  } catch {
    throw new Error(
      "No se pudo confirmar la suscripción. La solicitud queda guardada; Reintentar conserva su clave original.",
    );
  }
}
async function pushMutation(name: string, input: Record<string, unknown>) {
  const pending = await stored<PushIntent>(pendingKey, "get");
  if (pending)
    throw new Error(
      "Hay una solicitud de notificaciones pendiente. Reintenta la activación antes de cambiarla.",
    );
  const intent = { operation: name, input: { ...input, idempotency_key: crypto.randomUUID() } };
  await stored(pendingKey, "put", intent);
  await resolveIntent(intent);
}
function sameKey(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
