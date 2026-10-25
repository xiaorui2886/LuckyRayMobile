import { openUrl } from '@tauri-apps/plugin-opener';

/** Web links leave the app through the existing native opener, never its WebView.
 * Note references and authorized attachments must keep their own scoped routes. */
export async function openExternalWebLink(target: string): Promise<void> {
  if (!/^https?:\/\//i.test(target) || /[\u0000-\u0020\u007f\\]/.test(target)) {
    throw new Error('Unsupported external link');
  }
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Unsupported external link');
  }
  await openUrl(target);
}
