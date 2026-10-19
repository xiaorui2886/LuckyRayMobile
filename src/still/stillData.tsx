// STILL-01.1 production screens — Still Views composed with REAL data.
//
// Every screen here renders the Still authority component tree (Views.tsx /
// Still.tsx primitives, source-identical) and feeds it exclusively from
// production authorities: pagers, generation guards, coordinators,
// provenance, connectionShell. No demo data, no demo callbacks.
import { useEffect, useState } from "react";
import type { NoteItem } from '../presentation/still01/Views';
import type { NoteState } from "../presentation/still01/Still";
import { noteStatus, hasReadableBody } from "../services/noteProvenance";
import { localDataStore } from "../services/localDataStore";

export function useLocalDataVersion(): number {
  const [version, setVersion] = useState(() => localDataStore.getVersion());
  useEffect(() => {
    return localDataStore.subscribe(() => setVersion(localDataStore.getVersion()));
  }, []);
  return version;
}

export { noteStatus, hasReadableBody };

/** Still NoteItem from a real local note row. */
export function localNoteItem(n: any): NoteItem {
  return {
    id: n.noteId,
    title: n.title || "无标题笔记",
    body: n.content || "",
    source: "local",
    meta: localMeta(n.updatedAt),
    state: "local",
    notebook: "本机笔记",
    pinned: Boolean(n.pinned),
    archived: Boolean(n.archived),
    tags: n.tags || [],
  };
}

/** Still NoteItem from a real Desktop note row (provenance authority). */
export function desktopNoteItem(n: any, route: string): NoteItem {
  const st = noteStatus(n);
  const state: NoteState =
    st.key === "conflict" ? "conflict"
    : st.key === "pending" || st.key === "pending-delete" ? "pending"
    : st.key === "cached-outdated" ? "outdated"
    : st.key === "metadata-only" ? "metadata"
    : "synced";
  return {
    id: route,
    title: n.title || "无标题笔记",
    body: n.content || "",
    source: "desktop",
    meta: desktopMeta(n.updatedAt),
    state,
    notebook: n.vaultName || "LuckyRay 知识库",
  };
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function fmtTime(iso: string | undefined): string {
  return iso ? iso.replace("T", " ").slice(0, 16) : "";
}

/** Authority-style relative day label: 今天 / 昨天 / M 月 D 日. */
export function relativeDay(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(now)) return "今天";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (day(d) === day(yesterday)) return "昨天";
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 本机 note meta: 今天 · 10:24 */
export function localMeta(iso: string | undefined): string {
  const t = iso ? iso.slice(11, 16) : "";
  const day = relativeDay(iso);
  return day && t ? `${day} · ${t}` : t;
}

/** Desktop note meta: 电脑 · 今天 */
export function desktopMeta(iso: string | undefined): string {
  return `电脑 · ${relativeDay(iso)}`;
}
