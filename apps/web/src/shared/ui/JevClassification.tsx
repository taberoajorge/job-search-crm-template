import type { RecordData } from "../api/client";

const labels: Record<string, string> = {
  strong: "Fuerte",
  partial: "Parcial",
  weak: "Débil",
  insufficient_information: "Información insuficiente",
};
const tracks: Record<string, string> = {
  ai: "IA",
  general: "General",
  backend: "Backend",
  frontend: "Frontend",
};
type Answer = { choice: string; confidence: number };
type Triage = {
  state: string;
  updated_at: string;
  stale: boolean;
  jev: {
    status: string;
    rubric?: string;
    judgments?: Record<string, Answer>;
    criteria?: { id: string; criteria: string[] }[];
  } | null;
};
export function triageOf(job: RecordData) {
  return job.triage as Triage | null | undefined;
}
export function profileName(id: string) {
  const [track, country] = id.split("-");
  return `${tracks[track!] ?? track} · ${country}`;
}
export function reviewMatch(
  job: RecordData,
  profile: string,
  category: string,
  confidence: number,
) {
  if (!profile && !category && confidence === 0) return true;
  const triage = triageOf(job);
  if (!triage || triage.stale || triage.jev?.status !== "completed") return false;
  return Object.entries(triage.jev.judgments ?? {}).some(
    ([id, answer]) =>
      (!profile || id === profile) &&
      (!category || answer.choice === category) &&
      answer.confidence >= confidence,
  );
}
export function reviewPriority(job: RecordData, profile = "") {
  const t = triageOf(job);
  if (!t || t.stale || t.jev?.status !== "completed") return 3;
  const ranks: Record<string, number> = {
    strong: 0,
    partial: 1,
    insufficient_information: 2,
    weak: 4,
  };
  return Math.min(
    4,
    ...Object.entries(t.jev.judgments ?? {})
      .filter(([id]) => !profile || profile === id)
      .map(([, a]) => ranks[a.choice] ?? 3),
  );
}
export function JevClassification({
  job,
  expanded = false,
  fromList = false,
}: {
  job: RecordData;
  expanded?: boolean;
  /** List payloads omit criteria; only jobs.get carries them. */
  fromList?: boolean;
}) {
  const triage = triageOf(job);
  if (!triage) return <p className="caption">Jev: sin clasificación</p>;
  const jev = triage.jev;
  if (!jev || jev.status !== "completed")
    return (
      <p className="caption" role="status">
        Jev:{" "}
        {triage.state === "queued" || triage.state === "running"
          ? "clasificación pendiente"
          : jev?.status === "SOURCE_UNAVAILABLE"
            ? "publicación inaccesible · requiere revisión"
            : jev?.status === "CV_CRITERIA_UNAVAILABLE"
              ? "criterios del CV no disponibles o versión distinta · requiere revisión"
              : "sin resultado válido · requiere revisión"}
      </p>
    );
  return (
    <div className="jev-classification">
      {triage.stale && (
        <p role="status">
          Resultado anterior: requiere clasificación con los criterios actuales del CV.
        </p>
      )}
      <p className="jev-affinity">
        <strong>Afinidad Jev:</strong>{" "}
        {Object.entries(jev.judgments ?? {})
          .filter(([, answer]) => answer.choice === "strong" || answer.choice === "partial")
          .map(
            ([id, answer]) =>
              `${profileName(id)} ${labels[answer.choice]?.toLowerCase()} (${Math.round(answer.confidence * 100)}%)`,
          )
          .join(" · ") || "Sin afinidad fuerte/parcial; revisar información por perfil"}
      </p>
      <details open={expanded}>
        <summary>Jev · afinidad por perfil{triage.stale ? " (anterior)" : ""}</summary>
        <p className="caption">
          Confianza del modelo; no es precisión comprobada ni probabilidad de contratación.
        </p>
        <ul>
          {Object.entries(jev.judgments ?? {}).map(([id, answer]) => (
            <li key={id}>
              <strong>{profileName(id)}</strong>: {labels[answer.choice] ?? "Sin confirmar"} ·
              confianza {Math.round(answer.confidence * 100)}%
            </li>
          ))}
        </ul>
        <p className="caption">
          Actualizada: {new Date(triage.updated_at).toLocaleString("es-MX")}. No verifica salario,
          país elegible ni vigencia.
        </p>
        <details>
          <summary>Criterios usados</summary>
          {fromList && jev.criteria === undefined ? (
            <p>Los criterios están en el detalle de la vacante.</p>
          ) : jev.criteria?.length ? (
            jev.criteria.map((p) => (
              <section key={p.id}>
                <h3>{profileName(p.id)}</h3>
                {p.criteria.map((c, i) => (
                  <p key={i}>{c}</p>
                ))}
              </section>
            ))
          ) : (
            <p>
              Esta clasificación utilizó términos de búsqueda generales, sin evidencia del CV.
              Requiere una nueva clasificación.
            </p>
          )}
        </details>
      </details>
    </div>
  );
}
