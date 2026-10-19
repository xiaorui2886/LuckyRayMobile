export type Theme = "dark" | "light";
export function readTheme(): Theme {
  try { return localStorage.getItem("luckyray.theme") === "light" ? "light" : "dark"; }
  catch { return "dark"; }
}
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("luckyray.theme", theme); } catch { /* Session choice still applies. */ }
}
