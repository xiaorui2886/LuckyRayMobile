import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { runMobileMarkdownInsertion } from '../src/presentation/still01/editor/cmMobileMarkdownInsertion.ts';
function makeView({focus=true,title=false,sheet=false,current=true,connected=true,composing=false,compositionStarted=false}={}) {
  let changes=0,focusCalls=0;
  const view:any = {
    state:EditorState.create({doc:'正文',selection:{anchor:2},extensions:[history()]}),hasFocus:focus,composing,compositionStarted,
    dom:{isConnected:connected,closest:()=>({getAttribute:()=>String(current)}),ownerDocument:{activeElement:{closest:(selector:string)=>selector==='.st-note-title'?title:sheet}}},
    dispatch(value:any){const transactions=Array.isArray(value)?value:[value];view.state=transactions[transactions.length-1].state;if(transactions.some((t:any)=>t.docChanged))changes++;},
    focus(){focusCalls++;view.hasFocus=true;},
  };
  return {view,get changes(){return changes},get focusCalls(){return focusCalls}};
}
test('composition, detached, title and inactive retained editors cannot receive insertions', () => {
  for(const options of [{composing:true},{compositionStarted:true},{connected:false},{title:true},{current:false},{focus:false}]) {
    const run=makeView(options),state=run.view.state;
    assert.equal(runMobileMarkdownInsertion(run.view,'table'),false);
    assert.equal(run.view.state,state);assert.equal(run.changes,0);assert.equal(run.focusCalls,0);
  }
});
test('explicit More-sheet insertion uses the same state/save transaction and one undo', () => {
  const run=makeView({focus:false,sheet:true});
  assert.equal(runMobileMarkdownInsertion(run.view,'table'),true);
  assert.equal(run.changes,1);assert.equal(run.focusCalls,1);assert.match(run.view.state.doc.toString(),/\|/);
  assert.equal(undo({state:run.view.state,dispatch:(transaction:any)=>run.view.dispatch(transaction)}),true);
  assert.equal(run.view.state.doc.toString(),'正文');
});
