import { localWikiReferences } from '../../../still/kit/localWiki';
import { mobileLivePreviewModel } from './mobileLivePreviewModel';
import { editorImageRanges } from './editorImageRanges';
self.onmessage = (event:MessageEvent) => {
 const {id,kind,source,resources}=event.data;
 try {const result=kind==='preview'?mobileLivePreviewModel(source,resources):kind==='wiki'?localWikiReferences(source):editorImageRanges(source,resources);self.postMessage({id,result});}
 catch {self.postMessage({id,error:true});}
};
