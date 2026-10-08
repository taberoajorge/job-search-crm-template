import { useState } from "react";
import { contactPrivacyOutputs, type ContactErasurePreview } from "@crm/contracts";
import { operation } from "../api/client";
import { useExactWrite } from "../state/crm";

export function ContactErasure({ id }: { id: string }) {
  const [preview, setPreview] = useState<ContactErasurePreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState("");
  const write = useExactWrite(`erasure:${id}`);
  return (
    <section aria-label="Borrado permanente del contacto">
      <h3>Borrado permanente</h3>
      <p>
        Borra los datos personales del CRM y conserva el historial mínimo de relaciones y actividad.
        No elimina archivos descargados ni copias externas.
      </p>
      <button
        disabled={!navigator.onLine || write.pending || !!write.intent}
        onClick={async () => {
          setReviewed(false);
          setError("");
          try {
            setPreview(
              contactPrivacyOutputs["contacts.preview_erasure"].parse(
                await operation("contacts.preview_erasure", { id }),
              ),
            );
          } catch (failure) {
            setError(
              failure instanceof Error ? failure.message : "No se pudo preparar la revisión.",
            );
          }
        }}
      >
        Revisar alcance del borrado
      </button>
      {preview && (
        <>
          <dl>
            {Object.entries(preview.inventory).map(([family, count]) => (
              <div key={family}>
                <dt>
                  {(
                    {
                      contact: "Contacto",
                      outreach: "Conversaciones",
                      interviews: "Entrevistas",
                      audits: "Historial de cambios",
                      receipts: "Confirmaciones previas",
                      import_tasks: "Importaciones",
                      legacy_links: "Referencias históricas",
                      embeddings: "Índices de búsqueda",
                      automation_work: "Trabajos de automatización",
                    } as Record<string, string>
                  )[family] ?? family}
                </dt>
                <dd>{count}</dd>
              </div>
            ))}
          </dl>
          <h4>Copias que permanecen</h4>
          <ul>
            {preview.remaining_copies.map((copy) => (
              <li key={copy}>{copy}</li>
            ))}
          </ul>
          <h4>Limitaciones</h4>
          <ul>
            {preview.limitations.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
          <label>
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            He revisado este alcance y sus copias restantes
          </label>
          <button
            disabled={!reviewed || !navigator.onLine || write.pending || !!write.intent}
            onClick={async () => {
              if (
                !window.confirm(
                  "¿Borrar permanentemente los datos canónicos del contacto bajo este alcance revisado?",
                )
              )
                return;
              const result = await write.write("contacts.erase", {
                id,
                expected_version: preview.expected_version,
                inventory_hash: preview.inventory_hash,
                owner_reviewed: true,
              });
              if (result) {
                setPreview(null);
                setReviewed(false);
              }
            }}
          >
            Confirmar borrado permanente
          </button>
        </>
      )}
      {(error || write.error) && <p role="alert">{error || write.error}</p>}
      {write.confirmedRejected && (
        <button
          onClick={async () => {
            if (await write.discardRejected()) {
              setPreview(null);
              setReviewed(false);
            }
          }}
        >
          Descartar solicitud rechazada y revisar de nuevo
        </button>
      )}
      {write.intent && (
        <>
          <p>
            Resultado sin confirmar. Se conserva la solicitud original; una nueva revisión no la
            descarta.
          </p>
          <button
            disabled={!navigator.onLine || write.pending}
            onClick={async () => {
              if (await write.retry()) {
                setPreview(null);
                setReviewed(false);
              }
            }}
          >
            Reintentar borrado original
          </button>
        </>
      )}
    </section>
  );
}
