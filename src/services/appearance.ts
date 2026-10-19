// Appearance preferences (STITCH-R6) — Interface Style × Color Mode.
//
// Migrated from the approved R6 prototype: the user approved three interface
// styles, and Light/Dark stays a separate Color Mode.
//
//   interfaceStyle = quiet | ledger | night
//   colorMode      = light | dark
//
// These are PRESENTATION-ONLY, Mobile-local preferences. They must never add
// protocol fields, DB schema, Desktop contracts or sync semantics, and they
// must not change routes, data, capability or state authority. They are stored
// through the same frontend-local preference mechanism the app already uses for
// view preferences (localStorage), applied as data attributes on <html> so CSS
// owns every visual difference.
//
// Pure and dependency-free apart from localStorage, so the semantics are
// unit-testable.

export type InterfaceStyle = "quiet" | "ledger" | "night";
export type ColorMode = "light" | "dark";

export const DEFAULT_INTERFACE_STYLE: InterfaceStyle = "quiet";
export const DEFAULT_COLOR_MODE: ColorMode = "light";

const STYLE_KEY = "luckyray.interfaceStyle";
const MODE_KEY = "luckyray.theme"; // kept: existing Color Mode key, unchanged

export const INTERFACE_STYLES: readonly InterfaceStyle[] = ["quiet", "ledger", "night"];

export const STYLE_LABELS: Record<InterfaceStyle, string> = {
  quiet: "Quiet Dock",
  ledger: "Content Ledger",
  night: "Night Shelf",
};

export const STYLE_DESCRIPTIONS: Record<InterfaceStyle, string> = {
  quiet: "内容优先、低噪声、暖中性色",
  ledger: "方正克制、信息密度更高",
  night: "更沉静、媒体更突出",
};

export function isInterfaceStyle(value: unknown): value is InterfaceStyle {
  return value === "quiet" || value === "ledger" || value === "night";
}

export function normalizeInterfaceStyle(value: unknown): InterfaceStyle {
  return isInterfaceStyle(value) ? value : DEFAULT_INTERFACE_STYLE;
}

export function normalizeColorMode(value: unknown): ColorMode {
  return value === "dark" ? "dark" : "light";
}

export function readInterfaceStyle(): InterfaceStyle {
  try {
    return normalizeInterfaceStyle(localStorage.getItem(STYLE_KEY));
  } catch {
    return DEFAULT_INTERFACE_STYLE;
  }
}

export function readColorMode(): ColorMode {
  try {
    return normalizeColorMode(localStorage.getItem(MODE_KEY));
  } catch {
    return DEFAULT_COLOR_MODE;
  }
}

/** Apply the interface style as a document attribute (CSS owns the visuals). */
export function applyInterfaceStyle(style: InterfaceStyle): InterfaceStyle {
  const next = normalizeInterfaceStyle(style);
  document.documentElement.dataset.style = next;
  try {
    localStorage.setItem(STYLE_KEY, next);
  } catch {
    /* a session-only preference is still a valid preference */
  }
  return next;
}

export function applyColorMode(mode: ColorMode): ColorMode {
  const next = normalizeColorMode(mode);
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {
    /* session-only */
  }
  return next;
}

/** Apply both preferences at startup. */
export function applyAppearance(): { style: InterfaceStyle; mode: ColorMode } {
  const style = applyInterfaceStyle(readInterfaceStyle());
  const mode = applyColorMode(readColorMode());
  return { style, mode };
}
