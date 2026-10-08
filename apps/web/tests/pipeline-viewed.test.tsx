import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Pipeline } from "../src/screens/Pipeline";

const fixture = vi.hoisted(() => ({
  edit: vi.fn(),
  jobs: [
    {
      id: "legacy",
      version: 2,
      title: "Vacante histórica",
      stage: "radar",
      viewed: true,
      viewed_at: null,
    },
    {
      id: "dated",
      version: 3,
      title: "Vacante fechada",
      stage: "radar",
      viewed: false,
      viewed_at: "2026-10-01T12:00:00Z",
    },
    {
      id: "new",
      version: 5,
      title: "Vacante nueva",
      stage: "radar",
      viewed: false,
      viewed_at: null,
    },
  ],
}));
vi.mock("../src/shared/state/crm", () => ({
  useEdit: () => fixture.edit,
  useNotice: () => vi.fn(),
  useLookupRecords: (name: string) => ({
    records: name === "jobs.list" ? fixture.jobs : [],
    isFetching: false,
    hasNextPage: false,
    isError: false,
  }),
  useRecords: (name: string) => ({
    records: name === "jobs.list" ? fixture.jobs : [],
    isLoading: false,
    isError: false,
  }),
}));

it("preserves legacy viewed status without inventing dates, and stamps only a new explicit view", () => {
  render(<Pipeline open={vi.fn()} />);
  const viewed = screen.getAllByRole<HTMLButtonElement>("button", { name: "Vista" });
  expect(viewed).toHaveLength(2);
  expect(viewed.every((button) => button.disabled)).toBe(true);
  expect(fixture.jobs[0]?.viewed_at).toBeNull();
  expect(fixture.edit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Marcar vista" }));
  expect(fixture.edit).toHaveBeenCalledOnce();
  expect(fixture.edit).toHaveBeenCalledWith("jobs.upsert", {
    id: "new",
    expected_version: 5,
    viewed: true,
    viewed_at: expect.any(String),
  });
  expect(Number.isFinite(Date.parse(fixture.edit.mock.calls[0]?.[1].viewed_at))).toBe(true);
});
