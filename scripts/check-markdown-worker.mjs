import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const assets=path.join(root,'dist/assets');
const file=fs.readdirSync(assets).find(x=>/^markdownPreview\.worker-.*\.js$/.test(x));
assert.ok(file,'production Worker emitted');
const code=fs.readFileSync(path.join(assets,file),'utf8');
assert.match(code,/^\(function\(\)/,'self-contained classic-compatible IIFE');
const messages=[];const context={self:{postMessage:message=>messages.push(message)},console,setTimeout,clearTimeout,URL,URLSearchParams,TextEncoder,TextDecoder};
vm.createContext(context);vm.runInContext(code,context,{timeout:5000});
const source='# 开头正文不能丢失\n\n> 状态说明\n\n| A | B |\n| --- | --- |\n| 中文 | &copy; &amp; &NotEqualTilde; |\n\n```css\n.card { color: #fff; }\n```\n\n'+'普通正文 **内容**\n\n'.repeat(1000);
context.self.onmessage({data:{id:19,kind:'preview',source,resources:[]}});
assert.equal(messages[0].id,19);assert.equal(messages[0].error,undefined);assert.equal(messages[0].result.tables.length,1);
assert.ok(messages[0].result.lines.some(x=>x.className.includes('cm-lp-h1')&&x.from===0));
assert.equal(messages[0].result.tables[0].rows[1].cells[1].text,'© & ≂̸','official complete named entity table without document');
assert.ok(messages[0].result.lines.some(x=>x.className==='cm-lp-quote'));
assert.ok(messages[0].result.lines.some(x=>x.className.includes('cm-lp-code')));
const resource={resourceId:'r1',target:'attachments/test.png',status:'resolved',mimeType:'image/png'};
context.self.onmessage({data:{id:20,kind:'images',source:'![x](attachments/test.png)',resources:[resource]}});
assert.equal(messages[1].result[0].resource.resourceId,'r1');
const wikiSource='正文\n\n'.repeat(3000)+'[[Target]] and `[[Ignored]]`';
context.self.onmessage({data:{id:22,kind:'wiki',source:wikiSource,resources:[]}});
assert.equal(messages[2].id,22);assert.equal(messages[2].error,undefined);assert.equal(messages[2].result.length,1);assert.equal(messages[2].result[0].target,'Target');
const tailSource='# Start\n\nordinary body\n\n## Last-end-中文';
context.self.onmessage({data:{id:23,kind:'preview',source:tailSource,resources:[]}});
const tailReply=messages.at(-1);assert.equal(tailReply.id,23);assert.equal(tailReply.error,undefined);
assert.ok(tailReply.result.lines.some(line=>line.className==='cm-lp-blank-separator'));
assert.equal(Math.max(...tailReply.result.lines.map(line=>line.to)),tailSource.length,'final heading retained after appended separators');
assert.ok(tailReply.result.lines.some(line=>line.to===tailSource.length&&tailSource.slice(line.from,line.to)==='## Last-end-中文'));
console.log(JSON.stringify({artifact:file,format:'classic-compatible IIFE',validation:'Node VM only; not Android origin/worker/browser validation',previewCharacters:source.length,checks:['H1 at offset 0','quote','GFM table','fenced code','scoped image resource','request IDs','named entity semantics','long local backlinks off-thread grammar']},null,2));

// Optional owner-supplied original. Its text/path never enters the report or repo.
if (process.env.LR_ORIGINAL_MD) {
 const bytes=fs.readFileSync(process.env.LR_ORIGINAL_MD), original=bytes.toString('utf8');
 const hash=value=>createHash('sha256').update(value).digest('hex');
 const before=hash(bytes);
 context.self.onmessage({data:{id:21,kind:'preview',source:original,resources:[]}});
 const reply=messages.at(-1),model=reply.result;
 assert.equal(reply.id,21);assert.equal(reply.error,undefined);assert.ok(model&&!model.limited);
 assert.ok(model.lines.some(line=>line.from===0&&line.className.includes('cm-lp-h1')),'original starts with a body H1 at offset zero');
 assert.ok(model.lines.some(line=>line.className==='cm-lp-quote'),'original status quote retained');
 // Presentation passes may append separator decorations after earlier syntax
 // decorations. Array order is not document order; verify the furthest source
 // boundary without hiding a missing final line or changing the input text.
 assert.equal(Math.max(...model.lines.map(line=>line.to)),original.trimEnd().length,'last source line preserved through its final character');
 assert.ok(model.tables.length>0);assert.ok(model.lines.some(line=>line.className.includes('cm-lp-code')));
 for(const ranges of [model.spans,model.links,model.lines,model.tasks,model.tables,model.rules])for(const range of ranges)assert.ok(range.from>=0&&range.to<=original.length&&range.to>=range.from);
 assert.equal(hash(fs.readFileSync(process.env.LR_ORIGINAL_MD)),before);
 assert.equal(hash(Buffer.from(original,'utf8')),before);
 console.log(JSON.stringify({ownerOriginal:{bytes:bytes.length,utf16Characters:original.length,physicalLines:original.split('\n').length,sha256:before,artifact:file,bodyH1Offset:0,lastContentOffset:original.trimEnd().length,documentBytesUnchanged:true,limited:model.limited,counts:{spans:model.spans.length,links:model.links.length,decoratedLines:model.lines.length,tasks:model.tasks.length,tables:model.tables.length,rules:model.rules.length,codeBlocks:model.lines.filter(line=>line.className.includes('cm-lp-code')&&line.className.includes('is-first')).length},validation:'actual production IIFE in no-DOM VM; not a browser Worker or Android run'}},null,2));
}
