import assert from "node:assert/strict";
import test from "node:test";

test("old WebView own-property fallback supports Markdown dictionaries", async () => {
  const original = Object.getOwnPropertyDescriptor(Object, "hasOwn")!;
  Reflect.deleteProperty(Object, "hasOwn");
  try {
    await import("../src/services/webviewCompatibility.ts");
    const own = (Object as any).hasOwn;
    assert.equal(own(Object.create({ inherited: true }), "inherited"), false);
    assert.equal(own({ hasOwnProperty: false, value: null }, "value"), true);
    const dictionary = Object.create(null); dictionary.key = 1;
    assert.equal(own(dictionary, "key"), true);
    assert.equal(Object.keys(Object).includes("hasOwn"), false);
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: Markdown } = await import("react-markdown");
    const { default: gfm } = await import("remark-gfm");
    const output = renderToStaticMarkup(createElement(Markdown, {
      skipHtml: true, remarkPlugins: [gfm],
      children: "# 中文正文\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>",
    }));
    assert.match(output, /中文正文/);
    assert.match(output, /<table>/);
    assert.doesNotMatch(output, /<script/);
  } finally {
    Object.defineProperty(Object, "hasOwn", original);
  }
});

// ---------------------------------------------------------------------------
// UI-REFRESH-R1 — WebView 83 CSS compatibility guard.
//
// The MI 8 ships Android System WebView 83.0.4103.101. Flex `gap` shipped in
// Chrome 84, so any rule that pairs `display: flex` with `gap` silently loses
// its spacing on the actual device (observed as "本机2" instead of "本机 2").
// Grid `gap` has been supported since Chrome 57 and stays allowed.
// ---------------------------------------------------------------------------
test("ui-refresh-r1 — no flex container relies on CSS gap (WebView 83)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const css = readFileSync(join(import.meta.dirname, "..", "src", "app.css"), "utf8");

  // Walk declaration blocks; flag only flex containers that still declare gap.
  const offenders: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].split("\n").pop()!.trim();
    const body = match[2];
    const isFlex = /display\s*:\s*(inline-)?flex/.test(body);
    const hasGap = /(^|[;\s])gap\s*:/.test(body);
    if (isFlex && hasGap) offenders.push(selector);
  }
  assert.deepEqual(offenders, [], `flex containers must not use gap on WebView 83: ${offenders.join(", ")}`);

  // The sibling-spacing fallbacks must actually exist for the key primitives.
  // STITCH-R6: the primitive set was migrated to the approved R6 vocabulary
  // (row / list / tool-row / setting-row / notice), so these selectors are the
  // R6 equivalents of the previous Calm Editorial ones. The invariant being
  // guarded is unchanged: flex containers must not depend on `gap`.
  for (const sel of [".row-actions", ".note-foot", ".tile-flag", ".editor-meta-row", ".chip-scroll", ".btn-row", ".toast-host"]) {
    assert.ok(
      css.includes(`${sel} > * + *`) || css.includes(`${sel} >*+*`),
      `${sel} keeps explicit sibling spacing for old WebViews`
    );
  }
  // `.row` and `.setting-row` lay their children out with explicit per-child
  // margins (`.row-main { margin-left }`, `.row-actions > * + *`,
  // `.sr-icon { margin-right }`, …) instead of flex gap, which is the same
  // gap-free invariant the previous primitives satisfied.
  const spaced = [
    [".row-main", "margin-left"],
    [".row-actions", "margin-left"],
    [".row-chev", "margin-left"],
    [".sr-icon", "margin-right"],
  ] as const;
  for (const [sel, prop] of spaced) {
    // The declaration may live on the base rule or on a child/sibling rule
    // (`.row-actions > * + *`), so search the whole stylesheet for the pair.
    const idx = css.indexOf(sel);
    assert.ok(idx >= 0, `${sel} appears in the stylesheet`);
    const window = css.slice(idx, idx + 260);
    assert.ok(window.includes(prop), `${sel} is explicitly spaced with ${prop} (no flex gap)`);
  }
});
