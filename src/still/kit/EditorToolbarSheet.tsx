import { NoteActionIcon } from "../../presentation/still01/editor/NoteActionIcon";
import { useState } from 'react';
import { Sheet, Button } from './StillImports';
import { editorCommands } from '../../presentation/still01/editor/editorCommands';
import { changeToolbarPreferences, editorToolbarPreferences, normalizeToolbarPreferences, toolbarCommands, type ToolbarPreferences } from '../../presentation/still01/editor/editorToolbarPreferences';
import { useToolbarPreferences } from '../../presentation/still01/editor/useToolbarPreferences';
import './editorToolbarSheet.css';

export function EditorToolbarSheet({ registerOverlay, onClose }: { registerOverlay: (dismiss: () => void) => () => void; onClose: () => void }) {
  const preferences = useToolbarPreferences();
  const [sessionOnly, setSessionOnly] = useState(false);
  const visible = toolbarCommands(preferences);
  const hidden = editorCommands.filter(item => preferences.hidden.includes(item.command));
  const save = (value: ToolbarPreferences) => setSessionOnly(!editorToolbarPreferences.set(value));
  return <Sheet title="编辑工具栏" registerDismiss={registerOverlay} onClose={onClose}
    footer={<Button kind="quiet" onClick={() => save(normalizeToolbarPreferences(null))}>恢复默认工具栏</Button>}>
    <p className="st-sheet-copy">调整常用按钮，修改立即生效。</p>
    {sessionOnly ? <p className="st-sheet-copy" role="status">暂时无法记住设置，本次使用仍然有效。</p> : null}
    <div className="st-toolbar-settings">
      <ol aria-label="已显示的工具">
        {visible.map((item, index) => <li key={item.command}>
          <span className="st-toolbar-settings-label"><NoteActionIcon name={item.command}/>{item.label}</span>
          <button type="button" disabled={index === 0} aria-label={`上移${item.label}`} onClick={() => save(changeToolbarPreferences(preferences, item.command, 'up'))}><NoteActionIcon name="up" size={18}/></button>
          <button type="button" disabled={index === visible.length - 1} aria-label={`下移${item.label}`} onClick={() => save(changeToolbarPreferences(preferences, item.command, 'down'))}><NoteActionIcon name="down" size={18}/></button>
          <button type="button" disabled={visible.length === 1} aria-label={`隐藏${item.label}`} onClick={() => save(changeToolbarPreferences(preferences, item.command, 'hide'))}>隐藏</button>
        </li>)}
      </ol>
      {hidden.length ? <><h3>可添加的工具</h3><ul aria-label="已隐藏的工具">
        {hidden.map(item => <li key={item.command}><span className="st-toolbar-settings-label"><NoteActionIcon name={item.command}/>{item.label}</span>
          <button type="button" aria-label={`显示${item.label}`} onClick={() => save(changeToolbarPreferences(preferences, item.command, 'show'))}>添加</button></li>)}
      </ul></> : null}
    </div>
  </Sheet>;
}
