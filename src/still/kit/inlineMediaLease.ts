/** One detail owns one private media lease. Late results are released, never shown. */
export type MediaGrant = { url: string; token: string };
export function openInlineMediaLease(options: {
  cached: () => Promise<MediaGrant>;
  stream: () => Promise<MediaGrant>;
  release: (token: string) => Promise<unknown>;
  cancel: () => Promise<unknown>;
  ready: (url: string) => void;
  failed: (error: unknown) => void;
}) {
  let live = true;
  let token = "";
  const release = (value: string) => { void options.release(value).catch(() => {}); };
  void (async () => {
    try {
      let grant: MediaGrant;
      try { grant = await options.cached(); }
      catch (error) {
        // Permission/source/version failures may never turn into a stream retry.
        if (!live || !String(error).includes("CONTENT_NOT_CACHED")) throw error;
        grant = await options.stream();
      }
      if (!live) { release(grant.token); return; }
      token = grant.token;
      options.ready(grant.url);
    } catch (error) { if (live) options.failed(error); }
  })();
  return () => {
    if (!live) return;
    live = false;
    void options.cancel().catch(() => {});
    if (token) { release(token); token = ""; }
  };
}
