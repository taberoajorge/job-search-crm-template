import { Pipeline } from "../src/screens/Pipeline";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import * as api from "../src/shared/api/client";
import { useLookupRecords, useRecords } from "../src/shared/state/crm";
import {
  CollectionPager,
  CompanyIdentity,
  companyWebsite,
  useCollectionPage,
} from "../src/shared/ui/collections";

it("crosses server-page boundaries without skipping records and resets the visible page on filters", async () => {
  onlineManager.setOnline(true);
  const rows = Array.from({ length: 55 }, (_, i) => ({
    id: String(i),
    version: 1,
    title: `Vacante ${i}`,
  }));
  const rpc = vi.spyOn(api, "operation").mockImplementation(async (_name, input = {}) => {
    const filtered = input.stage ? rows.slice(0, 2) : rows;
    const start = Number(input.cursor || 0);
    return {
      items: filtered.slice(start, start + 50),
      has_more: start + 50 < filtered.length,
      next_cursor: start + 50 < filtered.length ? String(start + 50) : null,
    } as never;
  });
  function Harness() {
    const [stage, setStage] = useState("");
    const query = useRecords("jobs.list", stage ? { stage } : {});
    const page = useCollectionPage(query, stage);
    return (
      <>
        <button onClick={() => setStage("applied")}>Filtrar aplicadas</button>
        <button onClick={() => setStage("")}>Limpiar filtros</button>
        <CollectionPager page={page} label="vacantes" />
        <ul>
          {page.records.map((row) => (
            <li key={row.id}>{row.title as string}</li>
          ))}
        </ul>
      </>
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const app = render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  await screen.findByText("Vacante 11");
  const seen = [...screen.getAllByRole("listitem").map((el) => el.textContent)];
  for (let index = 1; index < 5; index++) {
    fireEvent.click(screen.getByRole("button", { name: "Página siguiente de vacantes" }));
    await screen.findByText(`Vacante ${index * 12}`);
    seen.push(...screen.getAllByRole("listitem").map((el) => el.textContent));
    expect(screen.getAllByRole("listitem").length).toBeLessThanOrEqual(12);
  }
  expect(seen).toEqual(rows.map((row) => row.title));
  expect(new Set(seen).size).toBe(55);
  expect(rpc).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Filtrar aplicadas" }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Página anterior de vacantes" }).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Limpiar filtros" }));
  await screen.findByText("Vacante 11");
  expect(screen.getAllByRole("listitem")[0]?.textContent).toBe("Vacante 0");
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Página anterior de vacantes" }).disabled,
  ).toBe(true);
  app.unmount();
  client.clear();
});

it("loads lookup cursors completely so company 51 can identify its records", async () => {
  onlineManager.setOnline(true);
  const rpc = vi.spyOn(api, "operation").mockImplementation(
    async (_name, input = {}) =>
      ({
        items: input.cursor
          ? [{ id: "51", version: 1, name: "Empresa después de 50" }]
          : Array.from({ length: 50 }, (_, i) => ({
              id: String(i),
              version: 1,
              name: `Empresa ${i}`,
            })),
        has_more: !input.cursor,
        next_cursor: input.cursor ? null : "next",
      }) as never,
  );
  function Lookup() {
    const query = useLookupRecords("companies.list");
    return <p>{query.records.find((row) => row.id === "51")?.name as string}</p>;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const app = render(
    <QueryClientProvider client={client}>
      <Lookup />
    </QueryClientProvider>,
  );
  await screen.findByText("Empresa después de 50");
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenLastCalledWith("companies.list", { limit: 50, cursor: "next" });
  app.unmount();
  client.clear();
});

it("keeps the final cached rows reachable offline and fills their page before advancing on reconnect", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const rows = Array.from({ length: 55 }, (_, i) => ({
    id: String(i),
    version: 1,
    title: `Registro ${i}`,
  }));
  const fetch = vi.fn();
  function OfflinePage() {
    const [records, setRecords] = useState(rows.slice(0, 50));
    const page = useCollectionPage({
      records,
      hasNextPage: records.length === 50,
      isFetching: false,
      fetchNextPage: async () => {
        fetch();
        setRecords(rows);
        return { isError: false } as never;
      },
    });
    return (
      <>
        <CollectionPager page={page} label="registros" />
        {page.records.map((row) => (
          <p key={row.id}>{String(row.title)}</p>
        ))}
      </>
    );
  }
  const app = render(<OfflinePage />);
  for (let n = 0; n < 4; n++)
    fireEvent.click(screen.getByRole("button", { name: "Página siguiente de registros" }));
  expect(screen.getByText("Registro 48")).toBeTruthy();
  expect(screen.getByText("Registro 49")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
  online.mockReturnValue(true);
  app.rerender(<OfflinePage />);
  fireEvent.click(screen.getByRole("button", { name: "Página siguiente de registros" }));
  await screen.findByText("Registro 50");
  expect(screen.getByText("Registro 54")).toBeTruthy();
  expect(fetch).toHaveBeenCalledOnce();
});

it("uses only a saved HTTPS company website for identity and falls back when its icon fails", () => {
  expect(
    companyWebsite({
      id: "a",
      version: 1,
      posting_url: "https://jobs.example.invalid/company/job",
    }),
  ).toBeNull();
  expect(companyWebsite({ id: "a", version: 1, website_url: "http://example.com" })).toBeNull();
  const company = {
    id: "a",
    version: 1,
    name: "Empresa",
    website_url: "https://example.com/about?from=home",
  };
  const app = render(<CompanyIdentity company={company} />);
  const logo = app.container.querySelector("img")!;
  expect(logo.getAttribute("src")).toBe("https://example.com/favicon.ico");
  expect(logo.getAttribute("referrerpolicy")).toBe("no-referrer");
  fireEvent.error(logo);
  expect(logo.hidden).toBe(true);
  expect(screen.getByRole("link", { name: "Empresa" }).getAttribute("href")).toBe(
    company.website_url,
  );
});

it("loads every matching pipeline cursor, separates views from closed filters, and pages only the table at its footer", async () => {
  onlineManager.setOnline(true);
  const rows = Array.from({ length: 93 }, (_, index) => ({
    id: `pipeline-${index}`,
    version: 1,
    title: `Resultado ${index + 1}`,
    description_summary: `Descripción guardada ${index + 1}`,
    stage: index % 2 ? "applied" : "radar",
    viewed: true,
  }));
  const rpc = vi.spyOn(api, "operation").mockImplementation(async (name, input = {}) => {
    const source = name === "jobs.list" ? rows : [];
    const offset = Number(input.cursor || 0);
    return {
      items: source.slice(offset, offset + 50),
      has_more: offset + 50 < source.length,
      next_cursor: offset + 50 < source.length ? String(offset + 50) : null,
    } as never;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container, unmount } = render(
    <QueryClientProvider client={client}>
      <Pipeline open={vi.fn()} />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Resultado 93" });
  expect(
    container.querySelectorAll('[data-agent-entity="jobs"][data-agent-action="card"]'),
  ).toHaveLength(93);
  expect(rpc.mock.calls.filter(([name]) => name === "jobs.list")).toHaveLength(2);
  expect(screen.getByText("93 oportunidades")).toBeTruthy();
  const filters = container.querySelector("dialog.filter-dialog");
  expect(filters?.hasAttribute("open")).toBe(false);
  expect(screen.getByRole("button", { name: "Filtros · 0" })).toBeTruthy();
  const views = screen.getByRole("group", { name: "Vista del pipeline" });
  expect(filters?.contains(views)).toBe(false);
  expect(screen.queryByRole("navigation", { name: "Paginación de oportunidades" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Vista previa: Resultado 1" }));
  expect(screen.getByRole("dialog", { name: "Resultado 1" }).textContent).toContain(
    "Descripción guardada 1",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cerrar vista previa" }));
  fireEvent.click(screen.getByRole("button", { name: "Tablero" }));
  expect(screen.getByRole("region", { name: "Tablero por etapas" })).toBeTruthy();
  expect(container.querySelectorAll(".pipeline-board .stage-group")).toHaveLength(11);
  fireEvent.change(screen.getByLabelText("Etapa del tablero"), { target: { value: "applied" } });
  expect(container.querySelector(".selected-column")?.getAttribute("aria-label")).toBe("Aplicada");
  expect(container.querySelectorAll('.selected-column [data-agent-action="card"]')).toHaveLength(
    46,
  );
  expect(
    container.querySelectorAll('[data-agent-entity="jobs"][data-agent-action="card"]'),
  ).toHaveLength(93);
  fireEvent.click(screen.getByRole("button", { name: "Tabla" }));
  expect(
    container.querySelectorAll('[data-agent-entity="jobs"][data-agent-action="row"]'),
  ).toHaveLength(12);
  const pager = screen.getByRole("navigation", { name: "Paginación de oportunidades" });
  expect(
    container.querySelector(".pipeline-results")!.compareDocumentPosition(pager) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(document.getElementById("crm-agent-payload")).toBeNull();
  unmount();
  client.clear();
}, 20000);

it("reorders a partial same-filter offline cache without changing cursor scope or claiming fresh results", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  onlineManager.setOnline(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["jobs.list", { sort: "created_desc" }], {
    pages: [
      {
        items: [
          {
            id: "a",
            version: 1,
            title: "old",
            created_at: "2026-10-03T12:00:00Z",
            posted_on: "2026-01-01",
          },
          {
            id: "b",
            version: 1,
            title: "new",
            created_at: "2026-10-02T12:00:00Z",
            posted_on: "2026-10-03",
          },
          {
            id: "c",
            version: 1,
            title: "unknown",
            created_at: "2026-10-01T12:00:00Z",
            posted_on: null,
          },
        ],
        next_cursor: "old-scope",
        has_more: true,
      },
    ],
    pageParams: [null],
  });
  const rpc = vi
    .spyOn(api, "operation")
    .mockResolvedValue({ items: [], next_cursor: null, has_more: false } as never);
  function Results() {
    const result = useLookupRecords("jobs.list", { sort: "posted_desc" });
    return (
      <>
        <p>{result.hasNextPage ? "partial" : "complete"}</p>
        {result.records.map((row) => (
          <p key={row.id}>{String(row.title)}</p>
        ))}
      </>
    );
  }
  const view = render(
    <QueryClientProvider client={client}>
      <Results />
    </QueryClientProvider>,
  );
  await screen.findByText("new");
  expect(screen.getAllByRole("paragraph").map((el) => el.textContent)).toEqual([
    "partial",
    "new",
    "old",
    "unknown",
  ]);
  expect(client.getQueryData(["jobs.list", { sort: "posted_desc" }])).toBeUndefined();
  expect(rpc).not.toHaveBeenCalled();
  view.unmount();
  client.clear();
  online.mockReturnValue(true);
  onlineManager.setOnline(true);
});
