// Read-only browser geometry evidence. This helper NEVER scrolls/focuses a
// locator, invokes the editor handle to navigate, or repairs the page under test.
import assert from "node:assert/strict";

export function intersectVisibleRects(rects) {
  if (!rects.length || rects.some(rect => !rect || !Number.isFinite(rect.top + rect.bottom + rect.left + rect.right))) return null;
  const result = { top: Math.max(...rects.map(rect => rect.top)), bottom: Math.min(...rects.map(rect => rect.bottom)),
    left: Math.max(...rects.map(rect => rect.left)), right: Math.min(...rects.map(rect => rect.right)) };
  return result.bottom > result.top && result.right > result.left ? result : null;
}

export function classifySearchGeometry(sample) {
  const viewport = intersectVisibleRects(sample.clips || []);
  const visibleHits = viewport ? (sample.hits || []).filter(hit => hit.display !== "none" && hit.visibility === "visible"
    && hit.rects.some(rect => rect.bottom > rect.top && rect.right > rect.left
      && rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1
      && rect.left >= viewport.left - 1 && rect.right <= viewport.right + 1)) : [];
  return { viewport, visibleHits, visible: visibleHits.length > 0 };
}

export async function sampleSearchGeometry(page, { selector, text, kind = "active" }) {
  return page.evaluate(({ selector, text, kind }) => {
    const root = document.querySelector(selector), host = root?.querySelector(".st-note-editor.is-cm");
    const scroller = host?.querySelector(".cm-scroller"), paper = host?.closest(".st-note-paper");
    const rect = value => ({ top: value.top, bottom: value.bottom, left: value.left, right: value.right });
    const clip = element => {
      const bounds = element.getBoundingClientRect();
      return { top: bounds.top + element.clientTop, left: bounds.left + element.clientLeft,
        bottom: bounds.top + element.clientTop + element.clientHeight, right: bounds.left + element.clientLeft + element.clientWidth };
    };
    if (!host || !scroller || !paper) return { missingEditor: true, clips: [], hits: [] };
    const visual = window.visualViewport;
    const clips = [clip(scroller), clip(host), clip(paper), rect(root.getBoundingClientRect()),
      { top: visual?.offsetTop || 0, left: visual?.offsetLeft || 0,
        bottom: (visual?.offsetTop || 0) + (visual?.height || window.innerHeight),
        right: (visual?.offsetLeft || 0) + (visual?.width || window.innerWidth) }];
    const candidates = kind === "active" ? [...host.querySelectorAll(".st-note-find-hit.is-current")]
      : [...host.querySelectorAll(".cm-line")].filter(line => line.textContent?.trim() === text);
    const hits = candidates.map(element => {
      const style = getComputedStyle(element), line = element.closest(".cm-line");
      const range = document.createRange(); range.selectNodeContents(element);
      return { text: element.textContent, display: style.display, visibility: style.visibility,
        rects: [...range.getClientRects()].map(rect), line: line?.textContent || "",
        before: line?.previousElementSibling?.textContent || "", after: line?.nextElementSibling?.textContent || "" };
    }).filter(hit => hit.text?.includes(text));
    const gaps = [...host.querySelectorAll(".cm-gap")].map(element => ({
      inlineHeight: element.style.height, display: getComputedStyle(element).display,
      height: element.getBoundingClientRect().height,
    }));
    return { sampledAt: performance.now(), clips, hits, gaps, count: root.querySelector(".st-note-find-count")?.textContent,
      cmScrollTop: scroller.scrollTop, cmScrollHeight: scroller.scrollHeight, cmClientHeight: scroller.clientHeight,
      paperScrollTop: paper.scrollTop, selection: host.__cmHandle?.getSelection(),
      renderedStart: [...host.querySelectorAll(".cm-line")].slice(0, 3).map(line => line.textContent) };
  }, { selector, text, kind });
}

function stableSignature(sample) {
  const classification = classifySearchGeometry(sample);
  const half = number => Math.round(number * 2) / 2;
  return JSON.stringify([half(sample.cmScrollTop || 0), half(sample.paperScrollTop || 0),
    classification.viewport, classification.visibleHits.map(hit => hit.rects.map(rect => Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, half(value)]))))]);
}

/** Require a real visible hit over four layout frames. A changed counter or
 * nonzero outer-paper scroll is insufficient. Diagnostics survive a failure. */
export async function waitForVisibleSearchHit(page, options, evidence) {
  const deadline = Date.now() + 3500;
  let previous = "", stable = 0;
  evidence.samples = [];
  while (Date.now() < deadline) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const sample = await sampleSearchGeometry(page, options);
    evidence.samples.push(sample);
    if (evidence.samples.length > 12) evidence.samples.shift();
    const classified = classifySearchGeometry(sample), signature = stableSignature(sample);
    stable = classified.visible && signature === previous ? stable + 1 : classified.visible ? 1 : 0;
    previous = signature;
    if (stable >= 4) {
      evidence.settled = { ...sample, ...classified, stableFrames: stable };
      return evidence.settled;
    }
  }
  assert.fail("The actual search hit never remained inside the CM scroller ∩ editor ∩ paper ∩ page viewport for four layout frames; see geometry samples.");
}
