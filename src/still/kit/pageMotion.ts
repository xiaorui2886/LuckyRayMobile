/** View-only transition classification; never changes navigation history. */
export type PageMotion = { key: number | null; name: string; parent: number | string | null; replacingAsset: boolean };
export function nextPageMotion(previous: PageMotion | null, next: Omit<PageMotion, "replacingAsset">): PageMotion {
  return { ...next, replacingAsset: !!previous && previous.key !== next.key && previous.name === "asset" && next.name === "asset" && previous.parent === next.parent };
}
