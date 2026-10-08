import { useEffect, useState } from "react";
import { ownerId } from "../api/client";
import { namespace, stored } from "./storage";

// ponytail: one owner-scoped document reuses IndexedDB; no separate draft database.
export type Recovery = Record<string, unknown>;
let memory: Recovery = {};
let persistenceError = "";
let restored = false;
let restoring: Promise<void> | null = null;
let writing = Promise.resolve();
const listeners = new Set<() => void>();
const key = () => namespace(ownerId) + ":recovery";
export async function restoreRecovery() {
  if (restored) return;
  if (!restoring)
    restoring = stored<Recovery>(key(), "get")
      .then((saved) => {
        memory = { ...saved, ...memory };
        restored = true;
        listeners.forEach((notify) => notify());
      })
      .finally(() => {
        restoring = null;
      });
  await restoring;
}
export function recoverySnapshot() {
  return memory;
}
export async function retainRecovery(name: string, value: unknown) {
  const previous = memory[name];
  if (value !== null) {
    memory[name] = value;
    listeners.forEach((notify) => notify());
  }
  writing = writing
    .catch(() => {})
    .then(async () => {
      const snapshot = structuredClone(memory);
      if (value === null && memory[name] === previous) delete snapshot[name];
      try {
        await stored(key(), "put", snapshot);
        persistenceError = "";
      } catch (failure) {
        persistenceError =
          "No se pudo guardar la recuperación local. Mantén esta pestaña abierta, reintenta o exporta antes de salir.";
        listeners.forEach((notify) => notify());
        throw failure;
      }
      if (value === null && memory[name] === previous) {
        delete memory[name];
        listeners.forEach((notify) => notify());
      }
    });
  await writing;
}
export async function clearRecovery() {
  await writing.catch(() => {});
  await stored(key(), "delete");
  memory = {};
  persistenceError = "";
  listeners.forEach((notify) => notify());
}
export function useRetained<T>(name: string) {
  const [, refresh] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    const notify = () => refresh((n) => n + 1);
    listeners.add(notify);
    void restoreRecovery().catch(() =>
      setError(
        "No se pudo restaurar el borrador. Mantén esta pestaña abierta; reintenta o exporta antes de salir.",
      ),
    );
    return () => {
      listeners.delete(notify);
    };
  }, [name]);
  const set = (value: T | null) => {
    void retainRecovery(name, value).then(
      () => setError(""),
      () =>
        setError(
          "No se pudo guardar el borrador localmente. Mantén esta pestaña abierta y exporta antes de salir.",
        ),
    );
  };
  return {
    ready: restored,
    value: (memory[name] as T | undefined) ?? null,
    set,
    error: error || persistenceError,
    retry: () =>
      restoreRecovery()
        .then(() => retainRecovery(name, memory[name] ?? null))
        .then(
          () => setError(""),
          () => setError("Almacenamiento no disponible."),
        ),
  };
}

export async function replaceRecovery(original: string, next: string, value: unknown) {
  writing = writing
    .catch(() => {})
    .then(async () => {
      const snapshot = { ...memory, [next]: value };
      delete snapshot[original];
      try {
        await stored(key(), "put", snapshot);
        persistenceError = "";
      } catch (failure) {
        persistenceError =
          "No se pudo guardar la recuperación local. Mantén esta pestaña abierta, reintenta o exporta antes de salir.";
        listeners.forEach((notify) => notify());
        throw failure;
      }
      delete memory[original];
      memory[next] = value;
      listeners.forEach((notify) => notify());
    });
  await writing;
}
