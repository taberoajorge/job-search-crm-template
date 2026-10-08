import { useId, type ReactNode } from "react";
import type { RecordData } from "../api/client";
import { agent } from "./controls";

export function ResourceTable({
  rows,
  entity,
  label,
  columns,
  actions,
  responsive = false,
}: {
  rows: RecordData[];
  entity: "companies" | "sources" | "tasks" | "contacts" | "outreach" | "resumes";
  responsive?: boolean;
  label: string;
  columns: { key: string; label: string; render: (row: RecordData) => ReactNode }[];
  actions: (row: RecordData) => ReactNode;
}) {
  const tableId = useId();
  return (
    <div className="resource-table-region" role="region" aria-label={label} tabIndex={0}>
      <table className={`resource-table${responsive ? " resource-table-responsive" : ""}`}>
        <caption>{label}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} id={`${tableId}-${column.key}`} scope="col">
                {column.label}
              </th>
            ))}
            <th id={`${tableId}-actions`} scope="col">
              Acciones
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} {...agent(entity, row.id, "row")}>
              {columns.map((column) => (
                <td key={column.key} headers={`${tableId}-${column.key}`} data-label={column.label}>
                  {column.render(row)}
                  {row.pending_local === true && column === columns[0] && (
                    <small>Pendiente local · sin confirmar</small>
                  )}
                </td>
              ))}
              <td headers={`${tableId}-actions`} data-label="Acciones">
                <div className="table-actions">{actions(row)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
