import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NoteSurface } from '../../src/presentation/still01/Still';
import { EditorToolbarSheet } from '../../src/still/kit/EditorToolbarSheet';
import { localWikiChoiceDetail } from '../../src/still/kit/localWiki';
export function mountToolbarFixture(element: HTMLElement, onCommand: (command: string) => void) {
  function Fixture() {
    const [settings, setSettings] = useState(false);
    return <div className="st-app" data-mode="light" data-reduced="true">
      <NoteSurface title="工具栏测试" body="仅合成正文" notebook="本机笔记" mode="edit" state="local"
        onBack={() => {}} onBrowse={() => {}} onMore={() => setSettings(true)} onNew={() => {}}
        onEdit={() => {}} onChange={() => {}} onFormat={() => {}} onSearch={() => {}} onState={() => {}}
        onCommand={onCommand} onAttach={() => onCommand('attachment')} />
      {settings ? <EditorToolbarSheet registerOverlay={() => () => {}} onClose={() => setSettings(false)} /> : null}
      <div data-test="preview">{localWikiChoiceDetail({ noteId: 'note-123456789', title: 'same', preview: '<img src=x onerror=alert(1)>' })}</div>
    </div>;
  }
  const root = createRoot(element); root.render(<Fixture />); return root;
}
