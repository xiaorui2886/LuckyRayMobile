import { safeFolderPath } from "./knowledgeFolderCatalog.ts";
/** Build once per catalog snapshot, not a full-catalog scan for every visible
 * folder. Implicit ancestors and empty folders both remain navigable. */
export function noteFolderTree(paths: readonly string[]): Map<string, string[]> {
  const buckets = new Map<string, Set<string>>();
  for (const path of paths) {
    if (!path || !safeFolderPath(path)) continue;
    const parts = path.split("/");
    for (let depth = 0; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join("/"), child = parts.slice(0, depth + 1).join("/");
      let bucket = buckets.get(parent); if (!bucket) { bucket = new Set(); buckets.set(parent, bucket); }
      bucket.add(child);
    }
  }
  return new Map([...buckets].map(([parent, children]) => [parent, [...children].sort((a, b) => a.localeCompare(b))]));
}
