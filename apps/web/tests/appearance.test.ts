import { expect, it, vi } from "vitest";
import { applyAppearance, readAppearance } from "../src/shared/theme/appearance";

it("validates preferences, restores selection and keeps the session usable when storage is blocked", () => {
  localStorage.removeItem("crm-appearance");
  delete document.documentElement.dataset.appearance;
  expect(readAppearance()).toBe("system");
  localStorage.setItem("crm-appearance", "invalid");
  expect(readAppearance()).toBe("system");
  expect(applyAppearance("dark")).toBe(true);
  delete document.documentElement.dataset.appearance;
  expect(readAppearance()).toBe("dark");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage blocked", "SecurityError");
  });
  expect(applyAppearance("light")).toBe(false);
  expect(readAppearance()).toBe("light");
  expect(applyAppearance("invalid", false)).toBe(true);
  expect(readAppearance()).toBe("system");
  delete document.documentElement.dataset.appearance;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Storage blocked", "SecurityError");
  });
  expect(readAppearance()).toBe("system");
});
