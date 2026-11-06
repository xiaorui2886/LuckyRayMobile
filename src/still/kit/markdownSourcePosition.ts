/** Build once per document. UTF-16 offsets match CodeMirror and mdast; CRLF is
 * one line ending. O(n) index + O(log lines) lookup instead of quadratic slices. */
export function markdownSourcePosition(source: string) {
  const starts=[0];
  for(let i=0;i<source.length;i++) {
    if(source.charCodeAt(i)===13){if(source.charCodeAt(i+1)===10)i++;starts.push(i+1);}
    else if(source.charCodeAt(i)===10)starts.push(i+1);
  }
  return (offset:number)=>{
    let lo=0,hi=starts.length;
    while(lo+1<hi){const mid=(lo+hi)>>>1;if(starts[mid]<=offset)lo=mid;else hi=mid;}
    return {offset,line:lo+1,column:offset-starts[lo]+1};
  };
}
