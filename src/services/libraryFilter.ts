// Library domain view model (M2.9): 全部 / 本机 / Desktop.
// Pure function so the exact domain semantics are unit-testable:
//  - "全部" merges active Local Assets + cached Desktop assets (when paired);
//  - "本机" shows Local Assets only (active, unless 归档 filter is active);
//  - "Desktop" shows cached Desktop assets only (available when paired);
//  - kind filtering maps UI chips (图片/视频/文档/文件) to local asset kinds.

export type LibraryDomain = "all" | "local" | "desktop";

export type LocalAsset = {
  assetId: string;
  kind: string; // image | video | document | file
  name: string;
  mime: string;
  sizeBytes: number;
  contentHash: string;
  localPath: string;
  source: string; // direct_import | inbox
  sourceInboxId?: string | null;
  archived: boolean;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  tags: string[];
};

export type DesktopAsset = {
  desktopAssetId: string;
  name: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  [k: string]: unknown;
};

export type LibraryFilterResult = {
  localItems: LocalAsset[];
  desktopItems: DesktopAsset[];
  subtitleText: string;
};

/** Map a UI kind chip ("" = 全部) to a Local Asset kind filter value. */
export function localKindFilter(kind: string): string | undefined {
  switch (kind) {
    case "图片":
      return "image";
    case "视频":
      return "video";
    case "文档":
      return "document";
    case "文件":
      return "file";
    default:
      return undefined;
  }
}

export function filterLibraryAssets(params: {
  domain: LibraryDomain;
  kind: string;
  localAssets: LocalAsset[];
  desktopAssets: DesktopAsset[];
  isPaired: boolean;
  /** Backend total matching the current query (may exceed loaded rows when
   * pagination is active). Used only for truthful count text (FIX-V1B P2). */
  localTotal?: number;
}): LibraryFilterResult {
  const { domain, kind, localAssets, desktopAssets, isPaired, localTotal } = params;
  const kindFilter = localKindFilter(kind);

  // FIX-V1 P1-2: Local Assets arrive already kind-filtered by SQL (the backend
  // paginates the filtered result set), so no client-side kind filter can
  // silently drop later pages. The kind chip still filters the Desktop cache
  // domain client-side (its own read-only cache view).
  const visibleLocal = localAssets;

  let localItems: LocalAsset[];
  let desktopItems: DesktopAsset[];
  switch (domain) {
    case "local":
      localItems = visibleLocal;
      desktopItems = [];
      break;
    case "desktop":
      localItems = [];
      // Desktop cached assets are their own domain: kind filters are mapped
      // to the Desktop kind vocabulary (image/video/document).
      desktopItems = isPaired ? desktopAssets.filter((a) => !kindFilter || a.kind === kindFilter) : [];
      break;
    case "all":
    default:
      localItems = visibleLocal;
      desktopItems = isPaired ? desktopAssets.filter((a) => !kindFilter || a.kind === kindFilter) : [];
      break;
  }

  const total = localItems.length + desktopItems.length;
  let subtitleText: string;
  if (domain === "local") {
    // Truthful count: distinguish loaded rows from the backend total when
    // pagination is active (FIX-V1B P2) — never show two adjacent "totals".
    const backendTotal = localTotal ?? localItems.length;
    subtitleText =
      localItems.length < backendTotal
        ? `已加载 ${localItems.length} / 共 ${backendTotal}`
        : `本机素材 · ${backendTotal}`;
  } else if (domain === "desktop") {
    subtitleText = isPaired ? `Desktop 缓存 · ${desktopItems.length}` : "未连接 Desktop";
  } else {
    subtitleText = `全部素材 · ${total}`;
  }

  return { localItems, desktopItems, subtitleText };
}
