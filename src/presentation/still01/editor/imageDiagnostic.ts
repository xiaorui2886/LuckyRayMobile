import type { EditorView } from '@codemirror/view';
import { inlineImageFacts, type EditorImageScope } from './cmInlineImages';

/** Opt-in synthetic fixture only. No network, persistence or native extra reads. */
export function acceptsImageDiagnostic(title: string, body: string): boolean {
 return /^LR-QA-Image\d+-\d{8}$/.test(title) && body.includes('QA-IMAGE-DIAGNOSTIC-ONLY');
}
export type ImageDiagnostic = {
 sourceMode: boolean; scope: boolean; revision: boolean; descriptors: number; resolvedImages: number;
 parsed: number; active: number; decorations: number; fieldFocused: boolean; fieldComposing: boolean;
 domFocused: boolean; composing: boolean; widgets: number; decoded: number; loading: number;
 failures: string[];
};
const errors: Record<string,string> = {
 '附件尚未保存到本地。':'missing', '本地附件校验未通过，无法打开。':'hash',
 '笔记版本已更新，请重新打开笔记后查看附件。':'revision', '附件与当前笔记版本尚未完成核对。':'unverified',
 '读取本地附件失败，原始内容未改变。':'read', '图片暂时无法显示':'decode',
};
const count = (value: number) => Math.min(99,Math.max(0,value));
export function captureImageDiagnostic(view: EditorView, scope: EditorImageScope | undefined, sourceMode: boolean): ImageDiagnostic {
 const facts = inlineImageFacts(view);
 const widgets = Array.from(view.contentDOM.querySelectorAll('.st-editor-image'));
 const images = widgets.flatMap(node => Array.from(node.querySelectorAll('img')));
 const captions = widgets.map(node => node.querySelector('.st-editor-image-caption')?.textContent || '');
 return { sourceMode, scope: Boolean(scope), revision: Boolean(scope?.revision),
  descriptors: count(scope?.resources.length || 0), resolvedImages: count(scope?.resources.filter(r=>r.status==='resolved'&&r.mimeType?.startsWith('image/')).length || 0),
  parsed: count(facts?.parsed || 0), active: count(facts?.active || 0), decorations: count(facts?.decorations || 0),
  fieldFocused: facts?.focused || false, fieldComposing: facts?.composing || false,
  domFocused: view.hasFocus, composing: view.composing || view.compositionStarted,
  widgets: count(widgets.length), decoded: count(images.filter(img=>!img.hidden&&img.complete&&img.naturalWidth>0).length),
  loading: count(captions.filter(text=>text==='正在加载图片…').length),
  failures: [...new Set(captions.flatMap(text=>errors[text]?[errors[text]]:[]))].slice(0,6),
 };
}
export function appendImageDiagnostic(samples: ImageDiagnostic[], next: ImageDiagnostic): ImageDiagnostic[] {
 if (samples.length && JSON.stringify(samples[samples.length-1])===JSON.stringify(next)) return samples;
 return [...samples.slice(-11),next];
}
