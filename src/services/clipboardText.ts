// SERVICES-ASSET-DETAIL-R1 — text copy for the ordinary product.
//
// Copies the EXACT canonical page URL byte-for-byte. Prefers the async
// Clipboard API when the engine provides it; falls back to a WebView-83-safe
// hidden-textarea + execCommand('copy') path. Never rewrites the URL.

export type CopyResult = "copied" | "failed";

async function copyViaClipboardApi(text: string): Promise<CopyResult> {
  try {
    const clip = (navigator as Navigator & { clipboard?: { writeText?: (t: string) => Promise<void> } }).clipboard;
    if (!clip || typeof clip.writeText !== "function") return "failed";
    await clip.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

function copyViaTextarea(text: string, doc: Document): CopyResult {
  try {
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    area.style.top = "0";
    doc.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = doc.execCommand("copy");
    } catch {
      ok = false;
    }
    doc.body.removeChild(area);
    return ok ? "copied" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Copy `text` exactly. Clipboard API first, textarea fallback second.
 * Never mutates the text; returns the truthful outcome either way.
 *
 * `docRef` is injectable so tests can drive the WebView-83 textarea fallback
 * without a real DOM; production omits it.
 */
export async function copyTextExact(
  text: string,
  docRef?: Document | null,
): Promise<CopyResult> {
  if (await copyViaClipboardApi(text) === "copied") return "copied";
  const doc = docRef === undefined
    ? (globalThis as { document?: Document }).document
    : docRef;
  if (!doc || typeof doc.createElement !== "function") return "failed";
  return copyViaTextarea(text, doc);
}
