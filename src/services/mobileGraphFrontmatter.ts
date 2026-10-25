/** Exact tag grammar of Desktop src-tauri/src/knowledge/index.rs parse_frontmatter_tags.
 * This intentionally is not an invented YAML parser and never extracts inline #tags. */
export function mobileGraphFrontmatterTags(content: string): string[] {
  const lines = content.replace(/^\uFEFF/,'').split(/\r?\n/);
  if (lines.shift()?.trim() !== '---') return [];
  const tags = new Set<string>(); let inList = false;
  const add = (value:string) => { const tag=value.trim().replace(/^"+|"+$/g,'').replace(/^'+|'+$/g,'').replace(/^#+/,'').trim(); if(tag)tags.add(tag); };
  for(const line of lines) {
    const text=line.trim();if(text==='---')break;
    const colon=text.indexOf(':');
    if(colon>=0 && ['tag','tags'].includes(text.slice(0,colon).trim().toLowerCase())) {
      const rest=text.slice(colon+1).trim();inList=!rest;
      for(const tag of rest.replace(/^[\[\]]+|[\[\]]+$/g,'').split(','))add(tag);
      continue;
    }
    if(inList){if(text.startsWith('-'))add(text.slice(1));else if(text)inList=false;}
  }
  return [...tags];
}
/** Preserve unrelated frontmatter/body byte-for-byte; only canonicalize tag fields. */
export function withMobileGraphTags(content:string,tags:string[]):string {
  if(tags.some(t=>/["\\\r\n,\[\]]/.test(t)))throw Error('标签不能包含引号、反斜杠、逗号或换行');
  const newline=content.includes('\r\n')?'\r\n':'\n';
  const empty=/^(\uFEFF?---\r?\n|---\r?\n)(---(?:\r?\n|$))/.exec(content);
  if(empty)return empty[1]+(tags.length?`tags:${newline}${tags.map(t=>`  - "${t}"`).join(newline)}${newline}`:'')+empty[2]+content.slice(empty[0].length);
  const match=/^(\uFEFF?---\r?\n|---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(content);
  if(!match) {
    if(content.replace(/^\uFEFF/,'').split(/\r?\n/)[0].trim()==='---')throw Error('笔记开头的属性区未闭合，请先在笔记中修复');
    return tags.length ? `---${newline}tags:${newline}${tags.map(t=>`  - "${t}"`).join(newline)}${newline}---${newline}${content}` : content;
  }
  const lines=match[2].split(/\r?\n/), kept:string[]=[];
  const scalar=(value:string):boolean=>{
    if(!value)return false;
    if(value.startsWith('"'))return /^"[^"\\\r\n]*"$/.test(value);
    if(value.startsWith("'"))return /^'[^'\r\n]*'$/.test(value);
    return !/[\[\]{}:&#*!|>?'"\\]/.test(value);
  };
  const inline=(value:string):boolean=>value.startsWith('[')&&value.endsWith(']')
    ? value.slice(1,-1).split(',').every(v=>!v.trim()||scalar(v.trim())) : scalar(value);
  let inTags=false, list=false;
  for(const line of lines){
    const t=line.trim();
    if(/^\s+(?:tag|tags)\s*:/i.test(line))throw Error('属性区包含嵌套或多行标签文本，请在笔记中编辑标签');
    if(/^(?:tag|tags)\s*:/i.test(line)){
      const rest=t.slice(t.indexOf(':')+1).trim();
      if(rest&&!inline(rest))throw Error('标签属性格式较复杂，请在笔记中编辑');
      inTags=true;list=!rest;continue;
    }
    if(inTags){
      if(!t||t.startsWith('#')){kept.push(line);continue;}
      if(t.startsWith('-')&&(list||/^\s/.test(line))){
        if(!list||!/^-(?:\s+)(.+)$/.test(t)||!scalar(t.slice(1).trim()))throw Error('标签列表包含复杂结构，请在笔记中编辑');
        continue;
      }
      if(/^\s/.test(line))throw Error('标签属性含有续行或嵌套结构，请在笔记中编辑');
      inTags=false;
    }
    kept.push(line);
  }
  if(tags.length)kept.push('tags:',...tags.map(t=>`  - "${t}"`));
  return match[1]+kept.join(newline)+match[3]+content.slice(match[0].length);
}
