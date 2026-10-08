import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { SCHEMA_VERSION } from "@crm/contracts";
export const schemaVersion = SCHEMA_VERSION;
export function namespace(owner: string) {
  return `crm:${owner}:v${schemaVersion}`;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("crm-private", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("owners");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function stored<T>(
  key: string,
  action: "get" | "put" | "delete",
  value?: T,
): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("owners", action === "get" ? "readonly" : "readwrite");
    const store = tx.objectStore("owners");
    const request =
      action === "get"
        ? store.get(key)
        : action === "put"
          ? store.put(value, key)
          : store.delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve(action === "get" ? (request.result as T) : undefined);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}
export function persister(owner: string): Persister & { deactivate: () => Promise<void> } {
  const key = namespace(owner);
  let active = true;
  let writing = Promise.resolve();
  let latest: PersistedClient | undefined;
  return {
    // Each cache event dehydrates the whole cache: keep one put running and only the newest
    // snapshot queued behind it, so a burst of events costs at most two writes.
    persistClient: (client: PersistedClient) => {
      const queued = latest !== undefined;
      latest = client;
      if (queued) return writing;
      writing = writing
        .catch(() => {})
        .then(async () => {
          const snapshot = latest;
          latest = undefined;
          if (active && snapshot) await stored(key, "put", snapshot);
        });
      return writing;
    },
    restoreClient: () => stored<PersistedClient>(key, "get"),
    removeClient: async () => {
      await writing.catch(() => {});
      await stored(key, "delete");
    },
    deactivate: async () => {
      active = false;
      await writing.catch(() => {});
      await stored(key, "delete");
    },
  };
}

const deviceValues = new Map<string, string | null>();
export function deviceSetting(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Blocked device storage leaves the current session usable. */
  }
  if (value !== undefined) deviceValues.set(key, value);
  return deviceValues.get(key) ?? null;
}
