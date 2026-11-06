/** Sheet-only visual state, independent of navigation, insets, and keyboard geometry. */
export class SystemBarScrim {
  private owners = new Set<object>();
  private listeners = new Set<() => void>();
  active() { return this.owners.size > 0; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  acquire() {
    const owner = {}; this.owners.add(owner); this.emit();
    return () => { if (this.owners.delete(owner)) this.emit(); };
  }
  private emit() { for (const listener of this.listeners) listener(); }
}
export const systemBarScrim = new SystemBarScrim();

/** Serialize native requests and collapse superseded appearances, including rapid close/reopen. */
export function systemBarUpdater(send: (dark: boolean, dimmed: boolean, statusRgb?: number, navigationRgb?: number) => Promise<unknown>, onFailure?: () => void) {
  let next: { dark: boolean; dimmed: boolean; statusRgb?: number; navigationRgb?: number } | null = null;
  let running = false, disposed = false;
  async function flush() {
    if (running || disposed) return;
    running = true;
    try {
      while (next && !disposed) {
        const value = next; next = null;
        try {
          const result = await send(value.dark, value.dimmed, value.statusRgb, value.navigationRgb);
          if (result === false) onFailure?.();
        } catch { onFailure?.(); /* Retry on the next appearance/lifecycle signal, never spin. */ }
      }
    } finally { running = false; }
  }
  return {
    request(dark: boolean, dimmed: boolean, statusRgb?: number, navigationRgb?: number) { if (!disposed) { next = { dark, dimmed, statusRgb, navigationRgb }; void flush(); } },
    dispose() { disposed = true; next = null; },
  };
}

/** CSS is the color/animation authority. Keep floating channels until the final
 * 8-bit conversion, like source-over compositing in the WebView. */
export type BarColor = readonly [number, number, number, number];
export function parseBarColor(value: string): BarColor | null {
  const parts = value.match(/^rgba?\(([^)]+)\)$/)?.[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return parts && parts.length >= 3 && parts.every(Number.isFinite)
    ? [parts[0], parts[1], parts[2], parts[3] ?? 1] : null;
}
export function compositeBarColor(base: BarColor, layers: { color: BarColor; opacity: number }[]): number {
  let rgb = base.slice(0, 3);
  for (const { color, opacity } of layers) {
    const alpha = Math.max(0, Math.min(1, color[3] * opacity));
    rgb = rgb.map((channel, i) => channel * (1 - alpha) + color[i] * alpha);
  }
  return rgb.reduce((packed, channel) => (packed << 8) | Math.max(0, Math.min(255, Math.round(channel))), 0);
}

/** Observe only modal/theme changes. Sample a bounded transition, not the whole
 * time a sheet is mounted. This follows open, close, Back and interrupted fades
 * from their actual computed opacity, rather than starting a second animation
 * in native code. Nested scrims each composite once, just as in the DOM. */
export function observeSystemBarAppearance(send: Parameters<typeof systemBarUpdater>[0]) {
  let frame = 0, until = 0, disposed = false, previous = "";
  const updater = systemBarUpdater(send, () => { previous = ""; });
  const sample = () => {
    frame = 0;
    if (disposed) return;
    const app = document.querySelector<HTMLElement>(".st-app");
    if (app) {
      const style = getComputedStyle(app);
      const base = parseBarColor(style.backgroundColor);
      if (base) {
        const layers = Array.from(app.querySelectorAll<HTMLElement>(".st-modal > .st-scrim"))
          .filter(node => node.getClientRects().length > 0)
          .map(node => { const css = getComputedStyle(node); return { color: parseBarColor(css.backgroundColor), opacity: css.visibility === "hidden" || css.visibility === "collapse" ? 0 : Number(css.opacity) }; })
          .filter((layer): layer is { color: BarColor; opacity: number } => layer.color !== null);
        const dark = app.dataset.mode === "dark";
        const statusRgb = compositeBarColor(base, layers), navigationRgb = compositeBarColor(base, []);
        const dimmed = layers.some(layer => layer.opacity * layer.color[3] > 0);
        const key = `${dark}:${dimmed}:${statusRgb}:${navigationRgb}`;
        if (key !== previous) { previous = key; updater.request(dark, dimmed, statusRgb, navigationRgb); }
      }
    }
    if (!app) {
      // Startup/health gates can temporarily remove the presentation tree.
      // Restore the established native theme fallback instead of retaining a
      // previous sheet's dim color until a new .st-app appears.
      const dark = document.documentElement.dataset.theme === "dark";
      const key = `fallback:${dark}`;
      if (key !== previous) { previous = key; updater.request(dark, false); }
    }
    if (performance.now() < until) frame = requestAnimationFrame(sample);
  };
  const schedule = () => {
    if (disposed) return;
    // Read each fade's declared duration/delay, including reduced motion.
    let duration = 0;
    document.querySelectorAll<HTMLElement>(".st-modal > .st-scrim").forEach(node => {
      const css = getComputedStyle(node);
      const ms = (s: string) => s.split(",").map(v => parseFloat(v) * (v.trim().endsWith("ms") ? 1 : 1000));
      const durations = ms(css.transitionDuration), delays = ms(css.transitionDelay);
      durations.forEach((value, i) => { duration = Math.max(duration, value + (delays[i % delays.length] || 0)); });
    });
    until = performance.now() + duration + (duration ? 34 : 0);
    if (!frame) frame = requestAnimationFrame(sample);
  };
  const relevantNode = (node: Node) => node instanceof Element && (node.matches(".st-app, .st-modal, .st-scrim") || !!node.querySelector(".st-app, .st-modal"));
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === "attributes"
      ? record.target instanceof Element && (record.target.matches("html, .st-app, .st-modal, .st-scrim, .st-detail-stage, .st-root-stage") || !!record.target.querySelector(".st-modal"))
      : [...record.addedNodes, ...record.removedNodes].some(relevantNode))) schedule();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["class", "style", "data-theme", "data-mode", "data-reduced", "hidden"] });
  const settle = (event: Event) => { if (!frame && event.target instanceof Element && event.target.matches(".st-scrim")) frame = requestAnimationFrame(sample); };
  document.addEventListener("transitionend", settle, true);
  document.addEventListener("transitioncancel", settle, true);
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (media.addEventListener) media.addEventListener("change", schedule);
  else media.addListener(schedule);
  const resume = () => { previous = ""; schedule(); };
  window.addEventListener("lr:main-resume", resume);
  const release = systemBarScrim.subscribe(schedule);
  schedule();
  return () => {
    disposed = true; cancelAnimationFrame(frame); release(); observer.disconnect(); updater.dispose();
    if (media.removeEventListener) media.removeEventListener("change", schedule);
    else media.removeListener(schedule);
    window.removeEventListener("lr:main-resume", resume);
    document.removeEventListener("transitionend", settle, true);
    document.removeEventListener("transitioncancel", settle, true);
  };
}
