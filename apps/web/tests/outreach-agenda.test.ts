import { describe, expect, it } from "vitest";
import { outreachAgenda, outreachCounts, projectOutreach } from "../src/shared/state/model";

const ids = { company: "company-a", other: "company-b", contact: "contact-a", job: "job-a" };
const base = { version: 1, created_at: "2026-10-08T12:00:00Z" };

describe("outreach agenda projection", () => {
  const contacts = [{ ...base, id: ids.contact, company_id: ids.company, name: "Ana" }];
  const jobs = [{ ...base, id: ids.job, company_id: ids.other, title: "Engineer" }];
  const companies = [
    { ...base, id: ids.company, name: "Contact Co" },
    { ...base, id: ids.other, name: "Vacancy Co" },
  ];

  it("uses occurred, scheduled, then created time without calling created time a send", () => {
    const rows = projectOutreach(
      [
        { ...base, id: "sent", state: "sent", occurred_at: "2026-10-07T12:00:00Z" },
        { ...base, id: "queued", state: "queued", scheduled_for: "2026-10-06T12:00:00Z" },
        { ...base, id: "draft", state: "draft" },
      ],
      [],
      [],
      [],
    );
    expect(rows.map((row) => row.id)).toEqual(["queued", "sent", "draft"]);
    expect(rows.find((row) => row.id === "sent")?.timeLabel).toBe("Ocurrido");
    expect(rows.find((row) => row.id === "draft")?.timeLabel).toBe("Registrado");
    expect(outreachAgenda(rows, Date.parse("2026-10-08T00:00:00Z"))[0]?.overdue).toBe(true);
  });

  it("matches exact stored company ids by selected relationship and keeps both relationships", () => {
    const event = {
      ...base,
      id: "event",
      state: "queued",
      contact_id: ids.contact,
      job_id: ids.job,
    };
    const rows = projectOutreach([event], contacts, jobs, companies, ids.other, "vacancy");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactCompany?.name).toBe("Contact Co");
    expect(rows[0]?.jobCompany?.name).toBe("Vacancy Co");
    expect(
      projectOutreach([event], contacts, jobs, companies, "Contact Co", "either"),
    ).toHaveLength(0);
  });

  it("counts distinct people separately from events", () => {
    const rows = projectOutreach(
      [
        { ...base, id: "one", contact_id: ids.contact, state: "sent" },
        { ...base, id: "two", contact_id: ids.contact, state: "responded" },
      ],
      contacts,
      jobs,
      companies,
    );
    expect(outreachCounts(rows)).toEqual({ people: 1, events: 2 });
  });
});
