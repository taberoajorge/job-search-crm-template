import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { EvidenceNotes } from "../src/shared/ui/EvidenceNotes";

it("separates explicit heading explanations without splitting URL schemes or times", () => {
  const value =
    "Introducción\n\nConsulta 12:30\nHora registrada\n\nhttps://example.test/source\nFuente pública\n\nCONTRASTE: Explicación extensa\nFuente conservada";
  const { container } = render(<EvidenceNotes value={value} />);
  const summaries = [...container.querySelectorAll(".evidence-section > summary")].map(
    (node) => node.textContent,
  );
  expect(summaries).toEqual(["Consulta 12:30", "https://example.test/source", "CONTRASTE:"]);
  expect(container.querySelectorAll(".evidence-section")[2]?.querySelector("p")?.textContent).toBe(
    "Explicación extensa\nFuente conservada",
  );
  expect(container.querySelector(".evidence-original p")?.textContent).toBe(value);
});
