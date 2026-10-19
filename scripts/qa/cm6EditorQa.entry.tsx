// CM6-EDITOR-R1 — VISUAL QA build only (never shipped). Renders the REAL
// production NoteSurface over the SAME data twice — the BASELINE textarea
// branch (byte-identical fallback, i.e. the a513 production look) and the
// CM6 adapter branch — plus the read view, at 360/392 in light and dark.
// Presentation comparison ONLY, not a save/IPC lifecycle proof. The separate
// cm6EditorLifecycle.test.mjs exercises production StillApp/StillNote saving.
// These controlled inputs are stateful, and empty cases really have no body.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { NoteSurface } from "../../src/presentation/still01/Still";
import { MobileCmEditor } from "../../src/presentation/still01/editor/MobileCmEditor";
import type { NoteBodyFocusRequest } from "../../src/presentation/still01/editor/noteTapEditing";
import "../../src/still/kit/noteSearch.css";
import "../../src/design/tokens.css";
import "../../src/app.css";
import "../../src/presentation/still01/still.css";

const TITLE = "会议记录：一季度规划";
const BODY = [
  "今天把知识库的第一季度计划过了一遍。",
  "",
  "## 重点",
  "- 目录同步与移动",
  "- 新建电脑笔记",
  "- 搜索高亮",
  "",
  "> 引用：先做编辑器底座，再谈扩展。",
].join("\n");

function Frame({ name, mode: initialMode, theme, width, cm, empty = false }: { name: string; mode: "read" | "edit"; theme: "light" | "dark"; width: number; cm: boolean; empty?: boolean }) {
  const [title, setTitle] = useState(empty ? "" : TITLE);
  const [body, setBody] = useState(empty ? "" : BODY);
  const [mode, setMode] = useState(initialMode);
  const scope = `qa|${theme}|${width}|${name}`;
  const [focusRequest, setFocusRequest] = useState<NoteBodyFocusRequest>();
  return (
    <section className="case" data-name={name}>
      <h2>{name}</h2>
      <div className="st-app" data-mode={theme} data-density={width <= 360 ? "compact" : "regular"} style={{ height: 620 }}>
        <NoteSurface
          title={title}
          body={body}
          notebook="本机笔记"
          state="local"
          mode={mode}
          savedLabel={mode === "edit" ? "已自动保存" : "本机笔记"}
          onBack={() => {}}
          onBrowse={() => {}}
          onMore={() => {}}
          onNew={() => {}}
          onEdit={offset => { if (offset !== undefined) setFocusRequest({scope, offset}); setMode("edit"); }}
          onChange={(nextTitle, nextBody) => { setTitle(nextTitle); setBody(nextBody); }}
          onFormat={() => {}}
          onSearch={() => {}}
          onState={() => {}}
          bodyEditor={cm ? (
            <MobileCmEditor
              scope={scope}
              value={body}
              onChange={setBody}
              placeholderText="写下第一个想法…"
              focusRequest={focusRequest}
            />
          ) : undefined}
        />
      </div>
    </section>
  );
}

function App() {
  const w = window.innerWidth;
  return (
    <div>
      <Frame name="cm6-baseline-textarea-edit" mode="edit" theme="light" width={w} cm={false} />
      <Frame name="cm6-adapter-edit" mode="edit" theme="light" width={w} cm />
      <Frame name="cm6-baseline-textarea-edit-dark" mode="edit" theme="dark" width={w} cm={false} />
      <Frame name="cm6-adapter-edit-dark" mode="edit" theme="dark" width={w} cm />
      <Frame name="cm6-baseline-read" mode="read" theme="light" width={w} cm={false} />
      <Frame name="cm6-adapter-read" mode="read" theme="light" width={w} cm />
      <Frame name="cm6-baseline-read-dark" mode="read" theme="dark" width={w} cm={false} />
      <Frame name="cm6-adapter-read-dark" mode="read" theme="dark" width={w} cm />
      <Frame name="cm6-empty-placeholder" mode="edit" theme="light" width={w} cm empty />
      <Frame name="cm6-empty-placeholder-dark" mode="edit" theme="dark" width={w} cm empty />
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
