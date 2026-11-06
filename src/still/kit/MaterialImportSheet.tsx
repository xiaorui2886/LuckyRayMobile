import { useEffect, useRef, useState } from 'react';
import { api } from '../../services/client';
import { failureCode, failureCopy } from '../../services/feedback';
import { Sheet } from './Sheet';

export type MaterialImportDestination = { kind: 'local' } | { kind: 'desktop'; instance: string; library: string; libraryName: string; folder: string | null; allowed: boolean; reason?: string };

export function materialImportFailure(error: unknown): string {
  const code = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (/MATERIAL_IMPORT_NOT_GRANTED|GRANT_REQUIRED|AUTH_REVOKED|SCOPE_DENIED/.test(code)) return '此电脑素材库尚未允许导入，请在电脑端检查原有授权。未改为导入本机。';
  if (/CONTENT_UPGRADE_REQUIRED|UNSUPPORTED|404|426/.test(code)) return '当前电脑端暂不支持此素材导入接口，请更新电脑端后重试。未改为导入本机。';
  if (/PAYLOAD_TOO_LARGE/.test(code)) return '文件超过本次导入上限（最多 64 MB），请选择较小的文件。';
  if (/FILE_CHANGED/.test(code)) return '所选文件已变化或无法读取，请重新选择。未提交到电脑素材库。';
  if (/INVALID_RECEIPT/.test(code)) return '电脑返回的入库回执无法核对，请先刷新原素材库确认结果，避免重复导入。';
  if (/SOURCE_CHANGED|SCOPE_UNAVAILABLE|SCOPE_MISMATCH/.test(code)) return '电脑连接或所选素材库已变化，此次导入未被确认为完成。请回到原库核对。';
  const identifier = failureCode(error);
  return failureCopy(error, '导入未完成，请检查原电脑连接后重试。') + (identifier === 'SAVE_FAILED' ? '' : `（${identifier}）`);
}

/** The destination is captured by the plus button, never read again after SAF. */
export function MaterialImportSheet({ destination, onClose, registerDismiss, onImported }: {
  destination: MaterialImportDestination;
  onClose(): void;
  registerDismiss?: (close: () => void) => () => void;
  onImported(destination: MaterialImportDestination, name: string): void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const allowed = destination.kind === 'local' || destination.allowed;
  const importFile = async (kind: 'image' | 'video' | 'file') => {
    if (pending.current || !allowed) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = destination.kind === 'local' ? await api.localAssetImport(kind) : await api.contentMaterialImport(destination.instance, destination.library, destination.folder, kind);
      if (!mounted.current) return;
      if (result?.cancelled) return;
      if (destination.kind === 'desktop' && (!result?.completed || !result.assetId || !result.revision || result.instance !== destination.instance || result.libraryId !== destination.library || result.folderId !== destination.folder)) throw new Error('MATERIAL_IMPORT_INVALID_RECEIPT');
      onImported(destination, result?.name || '文件');
      onClose();
    } catch (e) { if (mounted.current) setError(materialImportFailure(e)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <Sheet title={destination.kind === 'desktop' ? '导入到电脑' : '导入到本机'} registerDismiss={registerDismiss} busy={busy} onClose={() => { if (!pending.current) onClose(); }}>
    {destination.kind === 'desktop' && <p className="st-sheet-caption" data-import-destination="desktop">{destination.libraryName} · {destination.folder ? '当前文件夹' : '根目录'}<br/><small>文件直接导入所选电脑素材库，不会另建本机素材。</small></p>}
    {!allowed && <p className="st-sheet-copy" role="alert">{destination.kind === 'desktop' && destination.reason || '当前电脑素材库暂不能导入，请检查连接及导入授权。'}</p>}
    <fieldset disabled={busy || !allowed} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {(['image','video','file'] as const).map(kind => <button key={kind} type="button" className="st-option" onClick={() => void importFile(kind)}><span>{({ image: '图片', video: '视频', file: '文件' })[kind]}<small>{kind === 'file' ? '文档、音频或压缩包' : '从相册选择'}</small></span></button>)}
    </fieldset>
    {busy && <p className="st-sheet-copy" role="status">{destination.kind === 'desktop' ? '正在导入电脑素材库，请稍候…' : '正在导入本机，请稍候…'}</p>}
    {error && <p className="st-sheet-copy" role="alert">{error}</p>}
  </Sheet>;
}
