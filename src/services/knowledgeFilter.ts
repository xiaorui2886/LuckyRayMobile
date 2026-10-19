// Pure filter helper for Knowledge screen (M2.8)
// Ensures domain visibility semantics are exact between 本机 (local) vs Desktop.

export type FilterMode = "all" | "local" | "desktop" | "pinned" | "favorite" | "archived";

export interface FilterNotesInput {
  localNotes: any[];
  desktopNotes: any[];
  filterMode: FilterMode;
  isPaired: boolean;
}

export interface FilterNotesOutput {
  displayLocalNotes: any[];
  displayDesktopNotes: any[];
  subtitleText: string;
}

export function filterKnowledgeNotes({
  localNotes,
  desktopNotes,
  filterMode,
  isPaired,
}: FilterNotesInput): FilterNotesOutput {
  let displayLocalNotes: any[] = [];
  let displayDesktopNotes: any[] = [];
  let subtitleText = "本机离线知识库";

  switch (filterMode) {
    case "local":
      displayLocalNotes = localNotes.filter((n) => !n.archived);
      displayDesktopNotes = [];
      subtitleText = "本机独享";
      break;

    case "desktop":
      displayLocalNotes = [];
      displayDesktopNotes = isPaired ? desktopNotes : [];
      subtitleText = isPaired ? "Desktop 同步笔记" : "未连接 Desktop";
      break;

    case "pinned":
      displayLocalNotes = localNotes.filter((n) => n.pinned && !n.archived);
      displayDesktopNotes = [];
      subtitleText = "已置顶笔记";
      break;

    case "favorite":
      displayLocalNotes = localNotes.filter((n) => n.favorite && !n.archived);
      displayDesktopNotes = [];
      subtitleText = "已收藏笔记";
      break;

    case "archived":
      displayLocalNotes = localNotes.filter((n) => n.archived);
      displayDesktopNotes = [];
      subtitleText = "已归档笔记";
      break;

    case "all":
    default:
      displayLocalNotes = localNotes.filter((n) => !n.archived);
      displayDesktopNotes = isPaired ? desktopNotes : [];
      subtitleText = isPaired ? "本机 + Desktop" : "本机离线知识库";
      break;
  }

  return {
    displayLocalNotes,
    displayDesktopNotes,
    subtitleText,
  };
}
