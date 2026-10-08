import type { getDocument, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ResourceTable } from "../shared/ui/resource-table";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  discardPendingResume,
  downloadResume,
  fetchResume,
  pendingResume,
  uploadResume,
  retryResumeFinalize,
} from "../shared/api/files";
import { useNotice, useRecords } from "../shared/state/crm";
import { text } from "../shared/state/model";
import { agent, Preview, Status } from "../shared/ui/controls";
import { CollectionPager, useCollectionPage } from "../shared/ui/collections";
export function Resumes() {
  const resumes = useRecords("resumes.list");
  const page = useCollectionPage(resumes);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const notice = useNotice();
  const client = useQueryClient();
  const checkReceipt = () =>
    void pendingResume().then(
      (value) => setReceipt(!!value),
      () => {},
    );
  useEffect(checkReceipt, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Currículums</h1>
          <p className="screen-lead">Elige la versión que vas a enviar a cada oportunidad.</p>
        </div>
      </div>
      <Preview title="Agregar currículum" trigger="Agregar currículum" keepMounted>
        <form
          className="card upload"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!navigator.onLine) return;
            const form = event.currentTarget;
            const data = new FormData(form);
            const file = data.get("file") as File;
            if (!window.confirm("¿Subir esta nueva versión privada de tu CV?")) return;
            setBusy(true);
            try {
              await uploadResume(file, {
                label: text(data.get("label")),
                country: text(data.get("country")) || null,
                track: text(data.get("track")) || null,
              });
              await client.invalidateQueries({ queryKey: ["resumes.list"] });
              notice("CV subido y checksum registrado.", "success");
              form.reset();
              form.closest("dialog")?.close();
            } catch (error) {
              notice(error instanceof Error ? error.message : "No se pudo subir el archivo.");
            } finally {
              setBusy(false);
              checkReceipt();
            }
          }}
        >
          <h2>Agregar una versión</h2>
          <label>
            Nombre de la versión
            <input name="label" required placeholder="Frontend · México · Octubre" />
          </label>
          <label>
            País
            <input name="country" />
          </label>
          <label>
            Enfoque profesional
            <input name="track" />
          </label>
          <label>
            Archivo PDF o DOCX, hasta 10 MB
            <input
              name="file"
              type="file"
              required
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            />
          </label>
          <div className="actions">
            <button className="primary" disabled={busy || !navigator.onLine}>
              {busy ? "Subiendo…" : "Subir CV privado"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={(event) => {
                const form = event.currentTarget.form;
                form?.reset();
                form?.closest("dialog")?.close();
              }}
            >
              Cancelar
            </button>
          </div>
          {!navigator.onLine && <p>Necesitas conexión para subir y descargar archivos.</p>}
        </form>
        {receipt && (
          <div className="actions">
            <button
              disabled={!navigator.onLine || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await retryResumeFinalize();
                  await client.invalidateQueries();
                  notice("Finalización recuperada.", "success");
                } catch (error) {
                  notice(error instanceof Error ? error.message : "No se pudo finalizar.");
                } finally {
                  setBusy(false);
                  checkReceipt();
                }
              }}
            >
              Recuperar finalización pendiente
            </button>
            <button
              disabled={busy}
              onClick={async () => {
                if (
                  !window.confirm(
                    "¿Descartar el CV pendiente? El archivo subido no quedará registrado y podrás subir otro.",
                  )
                )
                  return;
                await discardPendingResume();
                checkReceipt();
              }}
            >
              Descartar CV pendiente
            </button>
          </div>
        )}
      </Preview>
      <section aria-label="Versiones de currículum">
        <Status query={resumes} />
        <ResourceTable
          responsive
          rows={page.records}
          entity="resumes"
          label="Currículums en esta página"
          columns={[
            { key: "label", label: "Versión", render: (r) => <strong>{text(r.label)}</strong> },
            { key: "country", label: "País", render: (r) => text(r.country) || "Sin especificar" },
            { key: "track", label: "Perfil", render: (r) => text(r.track) || "Sin especificar" },
            {
              key: "state",
              label: "Estado",
              render: (r) => (
                <span className={`badge ${r.active ? "ready" : "archived"}`}>
                  {r.active ? "Activa" : "Histórica"}
                </span>
              ),
            },
          ]}
          actions={(r) => (
            <>
              <Preview title={text(r.label)} entity="resumes" id={r.id}>
                <details>
                  <summary>Información del archivo</summary>
                  <span>SHA-256: </span>
                  <code>{text(r.checksum)}</code>
                </details>
                <ResumeFile id={r.id} mediaType={text(r.media_type)} />
              </Preview>
              <button
                {...agent("resumes", r.id, "download")}
                disabled={!navigator.onLine}
                onClick={async () => {
                  try {
                    await downloadResume(r.id);
                    notice("Descarga preparada.", "success");
                  } catch (error) {
                    notice(error instanceof Error ? error.message : "No se pudo descargar.");
                  }
                }}
              >
                Descargar
              </button>
            </>
          )}
        />
        <CollectionPager page={page} label="currículums" />
      </section>
    </>
  );
}

export function ResumeFile({ id, mediaType }: { id: string; mediaType: string }) {
  const [retry, setRetry] = useState(0);
  const [file, setFile] = useState<{
    scope: string;
    url: string;
    pdf: PDFDocumentProxy | null;
    error: string;
  }>({ scope: "", url: "", pdf: null, error: "" });
  const [page, setPage] = useState(1);
  const [rendered, setRendered] = useState(0);
  const [pageText, setPageText] = useState("");
  const [renderError, setRenderError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const scope = `${id}:${mediaType}:${retry}`;
  const current = file.scope === scope ? file : { url: "", pdf: null, error: "" };
  useEffect(() => {
    if (mediaType !== "application/pdf") return;
    const controller = new AbortController();
    let resource = "";
    let loading: ReturnType<typeof getDocument> | undefined;
    void (async () => {
      try {
        const blob = await fetchResume(id, controller.signal);
        if (controller.signal.aborted) return;
        if (blob.type !== "application/pdf") throw new Error("El archivo no es un PDF válido.");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (controller.signal.aborted) return;
        resource = URL.createObjectURL(blob);
        const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
        if (controller.signal.aborted) return;
        GlobalWorkerOptions.workerSrc = pdfWorker;
        loading = getDocument({ data: bytes, useSystemFonts: true, wasmUrl: "/pdfjs/wasm/" });
        const pdf = await loading.promise;
        if (controller.signal.aborted) return;
        setPage(1);
        setFile({ scope, url: resource, pdf, error: "" });
      } catch (error) {
        if (!controller.signal.aborted)
          setFile({
            scope,
            url: resource,
            pdf: null,
            error: error instanceof Error ? error.message : "No se pudo abrir el archivo.",
          });
      }
    })();
    return () => {
      controller.abort();
      void loading?.destroy();
      if (resource) URL.revokeObjectURL(resource);
    };
  }, [id, mediaType, scope]);
  const pdf = current.pdf;
  useEffect(() => {
    if (!pdf || !canvas.current || !container.current) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    let chain = Promise.resolve();
    const render = () => {
      task?.cancel();
      chain = chain
        .catch(() => {})
        .then(async () => {
          if (cancelled) return;
          setRendered(0);
          setRenderError("");
          setPageText("");
          try {
            const documentPage = await pdf.getPage(page);
            if (cancelled || !canvas.current || !container.current) return;
            const natural = documentPage.getViewport({ scale: 1 });
            const width = Math.max(1, container.current.clientWidth);
            const viewport = documentPage.getViewport({ scale: width / natural.width });
            const outputScale = Math.min(window.devicePixelRatio || 1, 2);
            const target = canvas.current;
            target.width = Math.floor(viewport.width * outputScale);
            target.height = Math.floor(viewport.height * outputScale);
            target.style.width = `${viewport.width}px`;
            target.style.height = `${viewport.height}px`;
            task = documentPage.render({
              canvas: target,
              viewport,
              transform: [outputScale, 0, 0, outputScale, 0, 0],
            });
            await task.promise;
            const content = await documentPage.getTextContent();
            if (!cancelled) {
              setPageText(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
              setRendered(page);
            }
          } catch (error) {
            if (
              !cancelled &&
              !(error instanceof Error && error.name === "RenderingCancelledException")
            )
              setRenderError(
                "No se pudo renderizar esta página. Puedes abrir o descargar el original.",
              );
          }
        });
    };
    const observer = new ResizeObserver(render);
    observer.observe(container.current);
    render();
    return () => {
      cancelled = true;
      observer.disconnect();
      task?.cancel();
    };
  }, [pdf, page]);
  if (mediaType !== "application/pdf")
    return (
      <>
        <p>La vista previa de DOCX no está disponible. Usa Descargar para abrirlo.</p>
        <OriginalDownload id={id} />
      </>
    );
  return (
    <div className="resume-viewer">
      {current.url && (
        <div className="actions">
          <a href={current.url} target="_blank" rel="noopener noreferrer">
            Abrir PDF
          </a>
          <a href={current.url} download="curriculum.pdf">
            Descargar PDF
          </a>
        </div>
      )}
      {(current.error || (pdf && renderError)) && (
        <div role="alert">
          <p>{current.error || renderError}</p>
          <OriginalDownload id={id} />
          <button onClick={() => setRetry(retry + 1)}>Reintentar vista previa</button>
        </div>
      )}
      {pdf && (
        <div className="pdf-toolbar" role="toolbar" aria-label="Páginas del currículum">
          <button disabled={page === 1} onClick={() => setPage(page - 1)}>
            Anterior
          </button>
          <span aria-live="polite">
            Página {page} de {pdf.numPages}
          </span>
          <button disabled={page === pdf.numPages} onClick={() => setPage(page + 1)}>
            Siguiente
          </button>
        </div>
      )}
      {!current.error && (!pdf || (!renderError && rendered !== page)) && (
        <p role="status">Preparando vista previa privada…</p>
      )}
      <div ref={container} className="pdf-page">
        <canvas
          ref={canvas}
          hidden={!pdf}
          title="Vista previa del currículum PDF"
          role="img"
          aria-label={`Currículum, página ${page}`}
          data-rendered={!!pdf && rendered === page}
        />
      </div>
      {pdf && pageText && (
        <details>
          <summary>Texto de esta página</summary>
          <p>{pageText}</p>
        </details>
      )}
    </div>
  );
}

function OriginalDownload({ id }: { id: string }) {
  const notice = useNotice();
  return (
    <button
      disabled={!navigator.onLine}
      onClick={() =>
        void downloadResume(id).catch((error) =>
          notice(error instanceof Error ? error.message : "No se pudo descargar."),
        )
      }
    >
      Descargar original
    </button>
  );
}
