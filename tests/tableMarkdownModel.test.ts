import test from 'node:test';
import assert from 'node:assert/strict';
import {editableTable,editTableCell,safeCellInput,tableOperation,reorderTable} from '../src/presentation/still01/editor/tableMarkdownModel.ts';
const source='| A | B |\n| :--- | ---: |\n| **bold** | [[Note]] |\n| one | two |';
const apply=(s:string,c:ReturnType<typeof editTableCell>)=>c?s.slice(0,c.from)+c.insert+s.slice(c.to):s;
test('cell changes retain all untouched source bytes including spaces, inline markup and links',()=>{const table=editableTable(source)!;assert.ok(table);assert.equal(apply(source,editTableCell(table,2,0,'中文')),source.replace('one','中文'));assert.equal(apply(source,editTableCell(table,1,1,'[[Other|Alias]]')),source.replace('[[Note]]','[[Other\\|Alias]]'));});
test('pipes including adjacent pipes and backslashes are escaped idempotently',()=>{for(const value of ['|','||','a|||b','a\\|b','a\\\\|b','`a|b`','[[Note|Alias]]']){const safe=safeCellInput(value);assert.equal(safeCellInput(safe),safe);assert.ok(editableTable('| A |\n| --- |\n| '+safe+' |'),safe)}});
test('multiline/tab paste remains a single cell and never creates extra rows',()=>{const value=safeCellInput('a\r\nb\nc\td');assert.equal(value,'a b c d');assert.ok(editableTable('| A |\n| --- |\n| '+value+' |'));});
test('blank cells, optional edge pipes and CRLF preserve exact cell edit positions',()=>{for(const s of ['A | B\n--- | ---\none | two', '| A | B |\r\n| --- | --- |\r\n|  | b |']){const table=editableTable(s)!;assert.ok(table);const c=editTableCell(table,1,0,'x')!;assert.equal(s.slice(0,c.from)+c.insert+s.slice(c.to),apply(s,c));assert.ok(editableTable(apply(s,c)))}});
test('row and column edits remain parseable, preserve original values and guard header/last column',()=>{const table=editableTable(source)!;for(const op of ['row-before','row-after','row-delete','column-before','column-after','column-delete','align-left','align-center','align-right'] as const){const updated=apply(source,tableOperation(table,2,0,op));assert.ok(editableTable(updated),op);assert.ok(updated.includes('[[Note]]'),op)}assert.equal(tableOperation(table,0,0,'row-delete'),null);const one=editableTable('| A |\n| --- |\n| one |')!;assert.equal(tableOperation(one,1,0,'column-delete'),null);});
test('ambiguous uneven, container, malformed, oversized tables are rejected without normalization',()=>{for(const s of ['| A | B |\n| --- | --- |\n| one |','> | A |\n> | --- |\n> | x |','| A |\n| -- |\n| x |','| A |\n| --- |\n'+('| x |\n'.repeat(202))])assert.equal(editableTable(s),null)});

test('row reordering preserves header, delimiters, exact row whitespace and CRLF',()=>{
 const original='| A | B |\r\n| :--- | ---: |\r\n|  one  | `two` |\r\n| 三 | [[Note]] |';const table=editableTable(original)!;
 const next=apply(original,reorderTable(table,'row',1,2));assert.equal(next,'| A | B |\r\n| :--- | ---: |\r\n| 三 | [[Note]] |\r\n|  one  | `two` |');
 assert.equal(apply(next,reorderTable(editableTable(next)!,'row',2,1)),original);
 for(const [a,b]of [[0,1],[1,0],[1,1],[-1,1],[1,9],[1.5,1]])assert.equal(reorderTable(table,'row',a,b),null);
});
test('column reordering moves alignment and inline source together without interpreting Markdown',()=>{
 const original='| A | B | C |\n| :--- | :---: | ---: |\n| **a** | b\\|c | [[D]] |';const table=editableTable(original)!;
 const next=apply(original,reorderTable(table,'column',0,2));assert.equal(next,'| B | C | A |\n| :---: | ---: | :--- |\n| b\\|c | [[D]] | **a** |');
 assert.equal(apply(next,reorderTable(editableTable(next)!,'column',2,0)),original);
});
test('move, duplicate and stable natural sorting preserve every complete body row',()=>{
 const original='| Name | Value |\n| --- | ---: |\n| Item 10 | ten |\n| Item 2 | two |\n| Item 2 | same |',table=editableTable(original)!;
 const sorted=apply(original,tableOperation(table,1,0,'sort-ascending'));assert.equal(sorted,'| Name | Value |\n| --- | ---: |\n| Item 2 | two |\n| Item 2 | same |\n| Item 10 | ten |');
 assert.equal(editableTable(apply(original,tableOperation(table,1,0,'row-duplicate')))!.rows.length,5);
 const duplicate=editableTable(apply(original,tableOperation(table,1,1,'column-duplicate')))!;assert.deepEqual(duplicate.align,[null,'right','right']);assert.equal(duplicate.rows[1].cells[2].value,'ten');
 assert.equal(tableOperation(table,0,0,'row-up'),null);assert.equal(tableOperation(table,1,0,'column-left'),null);
});
