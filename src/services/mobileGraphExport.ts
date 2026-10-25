import { invoke } from '@tauri-apps/api/core';
export const MAX_GRAPH_PNG_BYTES = 8 * 1024 * 1024;
export type GraphExportAction = 'share' | 'save';
export type GraphExportResult = { status: 'ok' | 'created' | 'already_exists'; destination?: string; displayName?: string; uri?: string; bytes?: number };
/** Explicit UI action only; no browser-download fallback or arbitrary path IPC. */
export async function exportGraphPng(blob: Blob, action: GraphExportAction): Promise<GraphExportResult> {
  if (action !== 'share' && action !== 'save') throw new Error('GRAPH_EXPORT_ACTION_INVALID');
  if (blob.type !== 'image/png' || blob.size < 45 || blob.size > MAX_GRAPH_PNG_BYTES) throw new Error('GRAPH_PNG_INVALID_OR_TOO_LARGE');
  // FileReader works on the supported old Android WebView; no Buffer or newer Blob.bytes().
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('GRAPH_PNG_READ_FAILED'));
    reader.onabort = () => reject(new Error('GRAPH_PNG_READ_FAILED'));
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('GRAPH_PNG_READ_FAILED'));
    reader.readAsDataURL(blob);
  });
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) throw new Error('GRAPH_PNG_INVALID_OR_TOO_LARGE');
  const result = await invoke<GraphExportResult>('graph_export_png', { pngBase64: dataUrl.slice(prefix.length), action });
  if (!result || !['ok', 'created', 'already_exists'].includes(result.status)) throw new Error('GRAPH_EXPORT_FAILED');
  // `ok` means share chooser launched, not that a recipient received/saved it.
  return result;
}
