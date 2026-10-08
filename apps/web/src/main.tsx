import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { onlineManager } from "@tanstack/react-query";
import { Auth } from "./app/Auth";
import { App } from "./app/App";
import "./shared/theme/tokens.css";
import { applyAppearance, readAppearance } from "./shared/theme/appearance";
applyAppearance(readAppearance(), false);
onlineManager.setOnline(false);
onlineManager.setEventListener((setOnline) => {
  const offline = () => setOnline(false);
  window.addEventListener("offline", offline);
  return () => window.removeEventListener("offline", offline);
});
if (new URLSearchParams(location.search).get("agent-mode") === "true")
  document.documentElement.dataset.agentMode = "true";
const root = document.getElementById("root");
if (!root) throw new Error("No se encontró el contenedor de la aplicación.");
function Root() {
  return (
    <Auth>
      <App />
    </Auth>
  );
}

function OfflineShell() {
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void navigator.serviceWorker
      ?.register("/sw.js")
      .then((registration) => {
        const watch = (worker: ServiceWorker | null) =>
          worker?.addEventListener("statechange", () => {
            if (active && worker.state === "redundant")
              setError(
                "No se pudo preparar la reapertura sin conexión. Mantén conexión y reintenta.",
              );
          });
        watch(registration.installing);
        registration.addEventListener("updatefound", () => watch(registration.installing));
      })
      .catch(() => {
        if (active)
          setError("No se pudo preparar la reapertura sin conexión. Reintenta con conexión.");
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  return error ? (
    <div role="alert" className="sync">
      {error}
      <button
        onClick={() => {
          setError("");
          setAttempt((n) => n + 1);
        }}
      >
        Reintentar preparación sin conexión
      </button>
    </div>
  ) : null;
}
createRoot(root).render(
  <>
    <OfflineShell />
    <Root />
  </>,
);
