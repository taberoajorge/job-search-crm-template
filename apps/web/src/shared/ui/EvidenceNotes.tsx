import { Fragment } from "react";
import { ExternalLink, safeExternalUrl } from "./controls";

function EvidenceText({ value }: { value: string }) {
  return value.split(/(https?:\/\/[^\s<>]+)/g).map((part, index) => {
    let url = part.replace(/[.,;:"'”’]+$/, "");
    while (url.endsWith(")") && url.split(")").length > url.split("(").length) {
      url = url.slice(0, -1);
    }
    return /^https?:\/\//.test(part) && safeExternalUrl(url) ? (
      <Fragment key={index}>
        <ExternalLink href={url}>{url}</ExternalLink>
        {part.slice(url.length)}
      </Fragment>
    ) : (
      part
    );
  });
}

function EvidenceBody({ value }: { value: string }) {
  const start = value.search(/^[•*-]\s/m);
  const introduction = start < 0 ? value : value.slice(0, start);
  return (
    <>
      {introduction.trim() && (
        <p className="preserve-text">
          <EvidenceText value={introduction} />
        </p>
      )}
      {start >= 0 && (
        <ul>
          {value
            .slice(start)
            .split(/\n(?=[•*-]\s)/)
            .map((item, index) => (
              <li key={index} className="preserve-text">
                <EvidenceText value={item.replace(/^[•*-]\s/, "")} />
              </li>
            ))}
        </ul>
      )}
    </>
  );
}

export function EvidenceNotes({ value }: { value: string }) {
  if (!value.trim()) return <p>Sin evidencia registrada.</p>;
  const sections = value
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .filter((s) => s.trim());
  return (
    <div className="evidence-notes">
      {sections.map((section, index) => {
        const newline = section.indexOf("\n");
        const colon = section.slice(0, newline).search(/:(?:[ \t]|$)/);
        const headingEnd = colon > 0 && colon < newline ? colon + 1 : newline;
        return index > 0 && newline > 0 ? (
          <details key={index} className="evidence-section">
            <summary>{section.slice(0, headingEnd)}</summary>
            <EvidenceBody value={section.slice(headingEnd).trimStart()} />
          </details>
        ) : (
          <div key={index}>
            <EvidenceBody value={section} />
          </div>
        );
      })}
      <details className="evidence-original">
        <summary>Ver texto original completo</summary>
        <p className="preserve-text">{value}</p>
      </details>
    </div>
  );
}
