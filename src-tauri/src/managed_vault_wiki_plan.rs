//! Pure, fail-closed Markdown wiki migration. This is a deliberately bounded
//! parser, not a regex substitution or a filesystem resolver. Unsupported
//! Markdown contexts are rejected before any output is returned.
use std::collections::{BTreeMap, BTreeSet};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use sha2::{Digest,Sha256};

#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="camelCase")]
pub(crate) struct SourceNote {
    pub source_note_id:String,
    pub title:String,
    pub folder:String,
    pub historical_names:Vec<String>,
    pub content:String,
}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="camelCase")]
pub(crate) struct ReservedPath {pub source_note_id:String,pub note_id:String,pub relative_path:String}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="camelCase")]
pub(crate) struct RewrittenNote {pub source_note_id:String,pub note_id:String,pub relative_path:String,pub content:String,pub wiki_links:usize}
fn err(code:&str)->String{format!("LINKED_WIKI_{code}")}
fn clean_component(value:&str)->bool {
    if value.is_empty() || matches!(value,"."|"..") || value.trim()!=value || value.ends_with('.')
        || value.chars().any(|c|c.is_control()||"\\/:<>\"|?*[]#".contains(c)){return false;}
    let key=value.nfc().collect::<String>().to_uppercase();let stem=key.split('.').next().unwrap_or("");
    ![".LUCKYRAY",".OBSIDIAN",".GIT"].contains(&key.as_str()) && !key.starts_with(".LRK-")
        && !["CON","PRN","AUX","NUL"].contains(&stem)
        && !(stem.len()==4&&(stem.starts_with("COM")||stem.starts_with("LPT"))&&stem.as_bytes()[3].is_ascii_digit())
}
fn safe_path(path:&str,empty:bool)->bool{if path.is_empty(){return empty;}path.len()<=1024&&path.split('/').all(clean_component)}
fn title_key(value:&str)->String{let value=value.trim();let value=if value.len()>=3&&value.get(value.len()-3..).is_some_and(|s|s.eq_ignore_ascii_case(".md")){&value[..value.len()-3]}else{value};value.nfc().collect::<String>().to_lowercase()}
fn legacy_id(value:&str)->bool{value.strip_prefix("note-").is_some_and(|v| !v.is_empty()&&v.as_bytes()[0].is_ascii_alphanumeric()&&v.bytes().all(|b|b.is_ascii_alphanumeric()||b"._-".contains(&b)))}
fn resolve<'a>(target:&str,source:&'a [SourceNote])->Result<&'a SourceNote,String>{
    if target.is_empty()||target.len()>1024||target.starts_with('/')||target.contains('\\')||target.chars().any(|c|c.is_control()||":[]|".contains(c)){return Err(err("TARGET_INVALID"));}
    if let Some(id)=target.strip_prefix("@id/"){
        if id.is_empty()||id.len()>160||!id.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b)){return Err(err("TARGET_INVALID"));}
        return source.iter().find(|n|n.source_note_id==id).ok_or_else(||err("UNRESOLVED"));
    }
    let qualified=target.contains('/');let mut parts=Vec::new();
    for part in target.split('/') {match part {""|"."=>{},".."=>{if parts.pop().is_none(){return Err(err("TARGET_INVALID"));}},_=>parts.push(part)}}
    let name=parts.pop().ok_or_else(||err("TARGET_INVALID"))?;
    if target.ends_with('/')||matches!(target.rsplit('/').next(),Some("."|"..")){return Err(err("TARGET_INVALID"));}
    let trimmed=target.trim_start_matches("./");let global_legacy=legacy_id(trimmed);
    let folder=if qualified&&!global_legacy{Some(parts.join("/").nfc().collect::<String>())}else{None};
    // Stable IDs are never ambiguous title fallbacks, including missing IDs.
    if let Some(note)=source.iter().find(|n|n.source_note_id==name){return if folder.as_ref().is_none_or(|f|note.folder==*f){Ok(note)}else{Err(err("UNRESOLVED"))};}
    if legacy_id(name){return Err(err("UNRESOLVED"));}
    let key=title_key(name);let mut matches=source.iter().filter(|n|folder.as_ref().is_none_or(|f|nfc(&n.folder)==*f)
        &&(title_key(&n.title)==key||n.historical_names.iter().any(|h|title_key(h)==key)));
    let found=matches.next().ok_or_else(||err("UNRESOLVED"))?;
    if matches.next().is_some(){return Err(err("AMBIGUOUS"));}Ok(found)
}
fn nfc(s:&str)->String{s.nfc().collect()}
fn relative(from:&str,to:&str)->Result<String,String>{
    if !safe_path(from,false)||!safe_path(to,false){return Err(err("MAPPING_INVALID"));}
    let mut a=from.split('/').collect::<Vec<_>>();a.pop();let b=to.split('/').collect::<Vec<_>>();
    let shared=a.iter().zip(&b).take_while(|(a,b)|a==b).count();
    let mut parts=vec!["..";a.len()-shared];parts.extend_from_slice(&b[shared..]);
    let result=parts.join("/");Ok(if result.starts_with("../"){result}else{format!("./{result}")})
}
fn escaped(bytes:&[u8],at:usize)->bool{let mut count=0;let mut i=at;while i>0&&bytes[i-1]==b'\\'{count+=1;i-=1;}count%2==1}
fn run(bytes:&[u8],at:usize,byte:u8)->usize{bytes[at..].iter().take_while(|&&b|b==byte).count()}
fn nested_marker(line:&str)->bool{
    let s=line.trim_start_matches(' ');let bytes=s.as_bytes();
    s.starts_with('>') || ["- ","+ ","* "].iter().any(|p|s.starts_with(p))
        || {let count=bytes.iter().take_while(|b|b.is_ascii_digit()).count();count>0&&count<=9&&bytes.get(count).is_some_and(|b|matches!(b,b'.'|b')'))&&bytes.get(count+1).is_some_and(|b|matches!(b,b' '|b'\t'))}
}
/// Parse one proven paragraph/heading line. Ranges are byte-aligned, and only
/// the exact destination span of a literal wiki token may be replaced.
fn inline(line:&str,current:&ReservedPath,source:&[SourceNote],mapping:&BTreeMap<&str,&ReservedPath>)->Result<(String,usize),String>{
    let bytes=line.as_bytes();let mut i=0;let mut copied=0;let mut out=String::new();let mut count=0;
    while i<bytes.len(){
        if bytes[i]==b'`'&&!escaped(bytes,i){
            let size=run(bytes,i,b'`');let mut end=i+size;let mut found=None;
            while end<bytes.len(){if bytes[end]==b'`'{let n=run(bytes,end,b'`');if n==size{found=Some(end+n);break;}end+=n;}else{end+=1;}}
            // A multiline/unclosed code span is not guessed.
            i=found.ok_or_else(||err("UNSUPPORTED_CONTEXT"))?;continue;
        }
        for scheme in [b"lr-local:".as_slice(),b"local-asset:",b"local-inbox:",b"content://",b"file://",b"asset://",b"tauri://",b"luckyray-attachment:"] {
            if bytes[i..].get(..scheme.len()).is_some_and(|prefix|prefix.eq_ignore_ascii_case(scheme)){return Err(err("RESOURCE_UNRESOLVED"));}
        }
        if bytes[i]==b'<'&&!escaped(bytes,i){return Err(err("UNSUPPORTED_HTML"));}
        if bytes[i]==b'!'&&bytes.get(i+1)==Some(&b'[')&&!escaped(bytes,i){return Err(err("RESOURCE_UNRESOLVED"));}
        if bytes[i]==b'['&&bytes.get(i+1)==Some(&b'['){
            let end=line[i+2..].find("]]").map(|n|i+2+n).ok_or_else(||err("TOKEN_INVALID"))?;
            if escaped(bytes,i)||(i>0&&bytes[i-1]==b'!'){i=end+2;continue;}
            let prefix=line[..i].rsplit(char::is_whitespace).next().unwrap_or("");
            if prefix.contains("://")||prefix.to_ascii_lowercase().contains("www.")||prefix.contains('@'){return Err(err("UNSUPPORTED_CONTEXT"));}
            if line[end+2..].starts_with(['(', '[']) { return Err(err("UNSUPPORTED_CONTEXT")); }
            let token=&line[i+2..end];if token.contains(['[',']','\n','\r','`','\\','&']){return Err(err("TOKEN_INVALID"));}
            let alias_at=token.find('|').unwrap_or(token.len());let destination=&token[..alias_at];
            let heading_at=destination.find('#').unwrap_or(destination.len());let raw_claim=&destination[..heading_at];let claim=raw_claim.trim();let heading=&destination[heading_at..];
            if !heading.is_empty()&&(heading[1..].trim().is_empty()||heading.chars().any(char::is_control)){return Err(err("TARGET_INVALID"));}
            let target=resolve(claim,source)?;
            let reserved=mapping.get(target.source_note_id.as_str()).ok_or_else(||err("MAPPING_INVALID"))?;
            let rewritten=relative(&current.relative_path,&reserved.relative_path)?;
            // Preserve original whitespace, heading spelling, all alias bytes,
            // brackets and every byte outside the exact target text.
            let leading=raw_claim.len()-raw_claim.trim_start().len();let trailing=raw_claim.len()-raw_claim.trim_end().len();
            out.push_str(&line[copied..i+2]);out.push_str(&raw_claim[..leading]);out.push_str(&rewritten);
            if trailing>0{out.push_str(&raw_claim[raw_claim.len()-trailing..]);}
            out.push_str(heading);
            out.push_str(&token[alias_at..]);out.push_str("]]");copied=end+2;i=end+2;count+=1;continue;
        }
        if bytes[i]==b'['&&!escaped(bytes,i){
            // Preserve proven ordinary external links wholesale, including any
            // wiki-looking label, since Markdown does not recurse into links.
            let mut end=i+1;let mut depth=1;
            while end<bytes.len()&&depth>0{if !escaped(bytes,end){if bytes[end]==b'['{depth+=1;}else if bytes[end]==b']'{depth-=1;}}end+=1;}
            if depth!=0{return Err(err("UNSUPPORTED_CONTEXT"));}
            if bytes.get(end)!=Some(&b'('){return Err(err("UNSUPPORTED_REFERENCE"));}
            let close=line[end+1..].find(')').map(|n|end+1+n).ok_or_else(||err("UNSUPPORTED_CONTEXT"))?;
            let destination=line[end+1..close].trim();
            if destination.contains(['(', '\\', '\n', '\r']) || !(destination.starts_with("https://")||destination.starts_with("http://")||destination.starts_with("mailto:")||destination.starts_with('#')) {return Err(err("RESOURCE_UNRESOLVED"));}
            i=close+1;continue;
        }
        if bytes[i]==b']'&&bytes.get(i+1)==Some(&b'(')&&!escaped(bytes,i){return Err(err("UNSUPPORTED_CONTEXT"));}
        i+=1;
    }
    out.push_str(&line[copied..]);Ok((out,count))
}
fn rewrite(note:&SourceNote,current:&ReservedPath,source:&[SourceNote],mapping:&BTreeMap<&str,&ReservedPath>)->Result<(String,usize),String>{
    if note.content.len()>16*1024*1024||note.content.contains('\0')||note.content.as_bytes().iter().enumerate().any(|(i,b)|*b==b'\r'&&note.content.as_bytes().get(i+1)!=Some(&b'\n')){return Err(err("CONTENT_INVALID"));}
    // GFM table cell boundaries can split the apparent wiki alias at '|'.
    // Do not rewrite across those boundaries without a full table parser.
    let lines=note.content.lines().collect::<Vec<_>>();
    if note.content.contains("[[")&&lines.iter().any(|line|nested_marker(line)){return Err(err("UNSUPPORTED_CONTEXT"));}
    for pair in lines.windows(2) {
        let divider=pair[1].trim().trim_matches('|');
        if pair[0].contains('|')&&!divider.is_empty()&&divider.split('|').all(|cell|{let cell=cell.trim().trim_matches(':');!cell.is_empty()&&cell.bytes().all(|b|b==b'-')}){return Err(err("UNSUPPORTED_CONTEXT"));}
    }
    let mut fence:Option<(u8,usize)>=None;let mut out=String::new();let mut count=0;
    for line in note.content.split_inclusive('\n'){
        let bytes=line.as_bytes();let indent=bytes.iter().take_while(|&&b|b==b' ').count();let marker=bytes.get(indent).copied().unwrap_or(0);
        let markers=if matches!(marker,b'`'|b'~'){run(bytes,indent,marker)}else{0};
        if let Some((kind,size))=fence {
            if indent<=3&&marker==kind&&markers>=size&&line[indent+markers..].trim().is_empty(){fence=None;}
            out.push_str(line);continue;
        }
        if indent<=3&&markers>=3&&matches!(marker,b'`'|b'~'){
            if marker==b'`'&&line[indent+markers..].contains('`'){return Err(err("UNSUPPORTED_CONTEXT"));}
            fence=Some((marker,markers));out.push_str(line);continue;
        }
        // Reject uncertain containers rather than treating nested fences or
        // indented continuation prose as ordinary editable wiki text.
        if indent>=4||line.starts_with('\t')||nested_marker(line){
            if line.contains("[[")||line.contains('`')||line.contains('~')||line.contains('[')||line.contains('<'){return Err(err("UNSUPPORTED_CONTEXT"));}
            out.push_str(line);continue;
        }
        let (rewritten,n)=inline(line,current,source,mapping)?;out.push_str(&rewritten);count+=n;
    }
    Ok((out,count))
}
fn validate_mapping<'a>(source:&[SourceNote],reserved:&'a [ReservedPath])->Result<BTreeMap<&'a str,&'a ReservedPath>,String>{
    if source.is_empty()||source.len()>4096||source.len()!=reserved.len(){return Err(err("MAPPING_INVALID"));}
    let mut ids=BTreeSet::new();let mut mapping=BTreeMap::new();let mut destination_ids=BTreeSet::new();let mut paths=BTreeSet::new();
    for n in source {if n.source_note_id.is_empty()||!ids.insert(n.source_note_id.as_str())||!safe_path(&n.folder,true){return Err(err("SOURCE_INVALID"));}}
    for r in reserved {
        if !ids.contains(r.source_note_id.as_str())||!r.note_id.starts_with("kn-")||r.note_id.len()>160||!r.note_id.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b))||!destination_ids.insert(&r.note_id)||!safe_path(&r.relative_path,false)||!r.relative_path.to_ascii_lowercase().ends_with(".md")||!paths.insert(r.relative_path.nfc().collect::<String>().to_uppercase())||mapping.insert(r.source_note_id.as_str(),r).is_some(){return Err(err("MAPPING_INVALID"));}
    }
    for path in &paths {if paths.iter().any(|other|other!=path&&other.starts_with(&format!("{path}/"))){return Err(err("MAPPING_INVALID"));}}
    Ok(mapping)
}
pub(crate) fn rewrite_all(source:&[SourceNote],reserved:&[ReservedPath])->Result<Vec<RewrittenNote>,String>{
    let mapping=validate_mapping(source,reserved)?;
    let mut output=Vec::new();for n in source {let r=mapping[n.source_note_id.as_str()];let(content,wiki_links)=rewrite(n,r,source,&mapping)?;output.push(RewrittenNote{source_note_id:n.source_note_id.clone(),note_id:r.note_id.clone(),relative_path:r.relative_path.clone(),content,wiki_links});}Ok(output)
}

/// Syntax proof produced only by the installed frontend's Markdown AST pipeline.
/// This is not a security attestation: hash/range checks bind the trusted parser
/// result to exactly the immutable source bytes. Native still owns resolution.
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WikiSpan {pub start_byte:usize,pub end_byte:usize,pub token:String}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct SourceProof {pub source_note_id:String,pub source_sha256:String,pub spans:Vec<WikiSpan>,pub resource_issues:Vec<String>}
pub(crate) fn validate_proofs(source:&[SourceNote],proofs:&[SourceProof])->Result<(),String>{
    if proofs.len()!=source.len(){return Err(err("PROOF_INVALID"));}
    let mut by_id=BTreeMap::new();
    for p in proofs {if by_id.insert(p.source_note_id.as_str(),p).is_some(){return Err(err("PROOF_INVALID"));}}
    let mut seen=BTreeSet::new();
    for n in source {
        if !seen.insert(&n.source_note_id){return Err(err("PROOF_INVALID"));}
        let p=by_id.get(n.source_note_id.as_str()).ok_or_else(||err("PROOF_INVALID"))?;
        if n.content.len()>16*1024*1024||n.content.contains('\0')||p.source_sha256!=format!("{:x}",Sha256::digest(n.content.as_bytes()))||p.spans.len()>100000{return Err(err("PROOF_INVALID"));}
        if !p.resource_issues.is_empty(){return Err(err("RESOURCE_UNRESOLVED"));}
        let mut copied=0;
        for span in &p.spans {
            if span.start_byte<copied||span.start_byte>=span.end_byte||!n.content.is_char_boundary(span.start_byte)||!n.content.is_char_boundary(span.end_byte)||n.content.get(span.start_byte..span.end_byte)!=Some(span.token.as_str())||!span.token.starts_with("[[")||!span.token.ends_with("]]")||span.token.get(2..).and_then(|s|s.find("]]"))!=span.token.len().checked_sub(4){return Err(err("PROOF_INVALID"));}
            let token=&span.token[2..span.token.len()-2];
            if token.contains(['[',']','\n','\r','`','\\','&']){return Err(err("TOKEN_INVALID"));}
            let destination=token.split('|').next().ok_or_else(||err("TOKEN_INVALID"))?;
            let (claim,heading)=destination.split_once('#').map(|(a,b)|(a,Some(b))).unwrap_or((destination,None));
            if heading.is_some_and(|h|h.trim().is_empty()||h.chars().any(char::is_control)){return Err(err("TARGET_INVALID"));}
            resolve(claim.trim(),source)?;
            copied=span.end_byte;
        }
    }Ok(())
}
pub(crate) fn rewrite_all_proven(source:&[SourceNote],reserved:&[ReservedPath],proofs:&[SourceProof])->Result<Vec<RewrittenNote>,String>{
    let mapping=validate_mapping(source,reserved)?;
    validate_proofs(source,proofs)?;
    if proofs.len()!=source.len(){return Err(err("PROOF_INVALID"));}
    let mut by_id=BTreeMap::new();
    for p in proofs {if by_id.insert(p.source_note_id.as_str(),p).is_some(){return Err(err("PROOF_INVALID"));}}
    let mut result=Vec::new();
    for n in source {
        let p=by_id[n.source_note_id.as_str()];
        let current=mapping[n.source_note_id.as_str()];let mut out=String::new();let mut copied=0;
        for span in &p.spans {
            let (token,count)=inline(&span.token,current,source,&mapping)?;
            if count!=1{return Err(err("PROOF_INVALID"));}
            out.push_str(&n.content[copied..span.start_byte]);out.push_str(&token);copied=span.end_byte;
        }
        out.push_str(&n.content[copied..]);result.push(RewrittenNote{source_note_id:n.source_note_id.clone(),note_id:current.note_id.clone(),relative_path:current.relative_path.clone(),content:out,wiki_links:p.spans.len()});
    }Ok(result)
}

#[cfg(test)] mod tests {
    use super::*;
    fn note(id:&str,title:&str,folder:&str,body:&str)->SourceNote{SourceNote{source_note_id:id.into(),title:title.into(),folder:folder.into(),historical_names:vec![],content:body.into()}}
    fn path(id:&str,path:&str)->ReservedPath{ReservedPath{source_note_id:id.into(),note_id:format!("kn-{id}"),relative_path:path.into()}}
    fn proof(n:&SourceNote,tokens:&[&str])->SourceProof {SourceProof{source_note_id:n.source_note_id.clone(),source_sha256:format!("{:x}",Sha256::digest(n.content.as_bytes())),spans:tokens.iter().map(|token|{let start=n.content.find(token).unwrap();WikiSpan{start_byte:start,end_byte:start+token.len(),token:(*token).into()}}).collect(),resource_issues:vec![]}}
    #[test]fn proven_ast_supports_bullets_quotes_and_preserves_other_contexts(){let s=vec![note("a","A","","- 中文 [[B#标题|别名]]\n> [[@id/a]]\n`[[Missing]]` <span>[[Missing]]</span>"),note("b","B","", "[[A]]")];let proofs=vec![proof(&s[0],&["[[B#标题|别名]]","[[@id/a]]"]),proof(&s[1],&["[[A]]"])];let out=rewrite_all_proven(&s,&[path("a","A.md"),path("b","B.md")],&proofs).unwrap();assert_eq!(out[0].content,"- 中文 [[./B.md#标题|别名]]\n> [[./A.md]]\n`[[Missing]]` <span>[[Missing]]</span>");assert_eq!(out[1].content,"[[./A.md]]");}
    #[test]fn proven_ast_requires_exact_hash_ranges_membership_and_no_resource_issues(){let s=vec![note("a","A","","中文 [[B]]"),note("b","B","", "")];let r=[path("a","A.md"),path("b","B.md")];let good=vec![proof(&s[0],&["[[B]]"]),proof(&s[1],&[])];assert!(rewrite_all_proven(&s,&r,&good).is_ok());for kind in 0..9 {let mut bad=good.clone();match kind{0=>bad[0].source_sha256="x".into(),1=>bad[0].spans[0].start_byte=1,2=>bad[0].spans[0].end_byte=usize::MAX,3=>bad[0].spans[0].token="[[A]]".into(),4=>{let span=bad[0].spans[0].clone();bad[0].spans.push(span)},5=>bad[1]=bad[0].clone(),6=>bad[0].resource_issues.push("attachment".into()),7=>{bad.pop();},_=>bad[0].source_note_id="foreign".into()};assert!(rewrite_all_proven(&s,&r,&bad).is_err(),"{kind}");}}
    #[test]fn cycles_self_and_forward_are_exact(){let s=vec![note("a","A","","[[B]] [[@id/a#自己|我]]"),note("b","B","","[[C]]"),note("c","C","","[[A]]")];let r=vec![path("a","A.md"),path("b","B.md"),path("c","深层/C.md")];let out=rewrite_all(&s,&r).unwrap();assert_eq!(out[0].content,"[[./B.md]] [[./A.md#自己|我]]");assert_eq!(out[1].content,"[[./深层/C.md]]");assert_eq!(out[2].content,"[[../A.md]]");}
    #[test]fn code_and_escaped_wiki_are_byte_identical(){let body="`[[Missing]]` \\[[Missing]] [[B]]\r\n```rust\r\n[[Missing]]\r\n```\r\n";let s=vec![note("a","A","",body),note("b","B","","")];let out=rewrite_all(&s,&[path("a","A.md"),path("b","B.md")]).unwrap();assert_eq!(out[0].content,body.replace("[[B]]","[[./B.md]]"));}
    #[test]fn duplicates_and_history_are_ambiguous(){let mut s=vec![note("a","A","","[[Same]]"),note("b","Same","", ""),note("c","Other","","")];s[2].historical_names.push("Same".into());assert_eq!(rewrite_all(&s,&[path("a","A.md"),path("b","Same.md"),path("c","Other.md")]).unwrap_err(),"LINKED_WIKI_AMBIGUOUS");s[0].content="[[@id/b]]".into();assert!(rewrite_all(&s,&[path("a","A.md"),path("b","Same.md"),path("c","Other.md")]).is_ok());}
    #[test]fn qualified_names_follow_source_logical_root(){let s=vec![note("a","A","Dir","[[Other/B#标题|别名]]"),note("b","B","Other","")];let out=rewrite_all(&s,&[path("a","Dir/A.md"),path("b","Other/B.md")]).unwrap();assert_eq!(out[0].content,"[[../Other/B.md#标题|别名]]");}
    #[test]fn existing_markdown_external_label_is_not_wiki(){let s=vec![note("a","A","","[[B]] [label [[Missing]]](https://example.com)"),note("b","B","","")];assert_eq!(rewrite_all(&s,&[path("a","A.md"),path("b","B.md")]).unwrap()[0].content,"[[./B.md]] [label [[Missing]]](https://example.com)");}
    #[test]fn uncertain_resources_and_syntax_fail_closed(){for body in ["WWW.example.test/[[B]]","https://example.test/[[B]]","www.example.test/[[B]]","[[B]](https://example.test)","- item\n  ```\n[[B]]\n  ```\n","![[B]]","![b](b.png)","[b](b.md)","<span>[[B]]</span>","- [[B]]","    [[B]]","`unclosed [[B]]","[ref]: [[B]]","[[../B]]","[[B#]]"]{let s=vec![note("a","A","",body),note("b","B","","")];assert!(rewrite_all(&s,&[path("a","A.md"),path("b","B.md")]).is_err(),"{body}");}}
    #[test]fn invalid_mapping_never_emits_any_body(){for bad in ["../B.md","/B.md","B#heading.md","B|alias.md","C:\\B.md",".luckyray/B.md","A.md"]{let s=vec![note("a","A","","[[B]]"),note("b","B","","")];assert!(rewrite_all(&s,&[path("a","A.md"),path("b",bad)]).is_err(),"{bad}");}}
    #[test]fn unicode_nfc_title_and_exact_folder(){let s=vec![note("a","A","","[[目录/é|字]]"),note("b","e\u{301}","目录","")];assert_eq!(rewrite_all(&s,&[path("a","A.md"),path("b","目录/é.md")]).unwrap()[0].content,"[[./目录/é.md|字]]");}
    #[test]fn aliases_spacing_headings_and_surrounding_bytes_stay(){let s=vec![note("a","A","","头 [[  B  #原 标题  |别名|更多]] 尾"),note("b","B","","")];assert_eq!(rewrite_all(&s,&[path("a","A.md"),path("b","B.md")]).unwrap()[0].content,"头 [[  ./B.md  #原 标题  |别名|更多]] 尾");}
    #[test]fn missing_identity_never_falls_back_to_title(){let s=vec![note("a","A","","[[note-gone]]"),note("b","note-gone","","")];assert_eq!(rewrite_all(&s,&[path("a","A.md"),path("b","B.md")]).unwrap_err(),"LINKED_WIKI_UNRESOLVED");}
}
