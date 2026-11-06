export type KnowledgeMode = "notes" | "graph";
/** Knowledge mode is not a material source. No service calls belong here. */
export function KnowledgeModeSwitch({ value, onChange }: { value: KnowledgeMode; onChange: (mode: KnowledgeMode) => void }) {
  return <div className="st-source" role="group" aria-label="知识库视图">
    <span className={"st-source-glide " + (value === "graph" ? "is-desktop" : "")} aria-hidden="true" />
    {(["notes", "graph"] as const).map(mode => <button key={mode} aria-pressed={value === mode} onClick={() => onChange(mode)}><span className="st-source-label">{mode === "notes" ? "笔记" : "图谱"}</span></button>)}
  </div>;
}
