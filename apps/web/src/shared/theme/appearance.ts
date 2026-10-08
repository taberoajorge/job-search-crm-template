export type Appearance = "system" | "light" | "dark";
const key = "crm-appearance";
// ponytail: device-only preference; owner settings can provide sync if it is requested.
function valid(value: string | null | undefined): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}
export function readAppearance(): Appearance {
  if (document.documentElement.dataset.appearance)
    return valid(document.documentElement.dataset.appearance);
  try {
    return valid(localStorage.getItem(key));
  } catch {
    return "system";
  }
}
export function applyAppearance(value: string, persist = true): boolean {
  const appearance = valid(value);
  document.documentElement.dataset.appearance = appearance;
  if (!persist) return true;
  try {
    localStorage.setItem(key, appearance);
    return true;
  } catch {
    return false;
  }
}
