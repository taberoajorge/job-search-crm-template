import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { PreparationPack } from "../src/screens/JobDetail";
it("shows one preparation language with keyboard tabs and collapsed practice answers", () => {
  const app = render(
    <PreparationPack
      data={{
        stale: true,
        pack: {
          content: {
            introduction_es: "Presentación española",
            introduction_en: "English introduction",
            questions: [
              {
                question_es: "Pregunta",
                question_en: "Question",
                answer_es: "Respuesta",
                answer_en: "Answer",
                cv_evidence: "CV",
              },
            ],
            employer_questions_es: [],
            employer_questions_en: [],
            gaps: [],
          },
        },
      }}
    />,
  );
  expect(screen.getByText("Presentación española").closest("section")?.hidden).toBe(false);
  expect(screen.getByText("English introduction").closest("section")?.hidden).toBe(true);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Español" }), { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "English" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("English introduction").closest("section")?.hidden).toBe(false);
  expect(screen.getByText("Answer").closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: "Español" }));
  expect(screen.getByText("English introduction").closest("section")?.hidden).toBe(true);
  app.unmount();
});
