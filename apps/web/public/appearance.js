// Applies the saved Claro/Oscuro choice before first paint: a classic blocking script, allowed by
// the 'self' script policy. src/shared/theme/appearance.ts reads the same key afterwards.
try {
  var appearance = localStorage.getItem("crm-appearance");
  if (appearance === "light" || appearance === "dark")
    document.documentElement.dataset.appearance = appearance;
} catch {
  /* Blocked storage keeps the system appearance. */
}
