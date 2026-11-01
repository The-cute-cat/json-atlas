import test from 'node:test';
import assert from 'node:assert/strict';
import { ideModel, normalizeViewMode, parseIdeText, formatIdeText, ideDecorations, ideTextLines, ideProjection, ideProjectedEdit } from '../src/ide-view.js';
import { searchData } from '../src/data.js';

const doc = data => ({data, text:JSON.stringify(data), size:100});
test('nested folding preserves original numbers, quoted braces, and hidden source when editing', () => {
  const raw = '{\n  "a": {\n    "s": "[{}]"\n  },\n  "b": 1\n}';
  const projection = ideProjection(raw, new Set([1]));
  assert.deepEqual(projection.lines.map(line=>line.path[0]),[0,1,3,4,5]);
  assert.equal(projection.lines[1].folded,true);
  assert.equal(projection.lines[2].decoration.tokens[0].className,'ide-bracket-1');
  const edited = ideProjectedEdit(raw, projection, projection.text.replace('"b": 1','"b": 2'));
  assert.equal(edited.text,raw.replace('"b": 1','"b": 2'));
  assert.equal(ideProjectedEdit(raw,projection,''),null,'deleting across hidden text must expand instead');
  assert.equal(ideProjection(raw,new Set([0,1])).text,'{\n}');
  assert.equal(ideProjection(raw,new Set([1])).text,projection.text,'inner folds survive outer folding');
  assert.equal(ideDecorations(ideTextLines('"[{}]"'))[0].foldEnd,undefined);
  assert.equal(ideDecorations(ideTextLines('{\n "unfinished: [\n}'))[0].foldEnd,2);
});
test('bracket colours match pairs across lines and ignore quoted or incomplete string brackets', () => {
  const result = ideDecorations(ideTextLines('{\n  "records": [\n    {"literal": "[{}]"}\n  ]\n}'));
  const brackets = row => row.tokens.filter(token=>token.className.startsWith('ide-bracket-')).map(token=>[token.text,token.className]);
  assert.deepEqual(brackets(result[0]),[['{','ide-bracket-0']]);
  assert.deepEqual(brackets(result[1]),[['[','ide-bracket-1']]);
  assert.deepEqual(brackets(result[2]),[['{','ide-bracket-2'],['}','ide-bracket-2']]);
  assert.deepEqual(brackets(result[3]),[[']','ide-bracket-1']]);
  assert.deepEqual(brackets(result[4]),[['}','ide-bracket-0']]);
  assert.deepEqual(result[2].guides,[{column:0,colour:0},{column:2,colour:1}]);
  assert.deepEqual(result[3].guides,[{column:0,colour:0}]);
  assert.deepEqual(result[4].guides,[]);
  const draft=ideDecorations(ideTextLines('"unfinished [{ ' + '\\'));
  assert.deepEqual(brackets(draft[0]),[]);
  assert.equal(ideDecorations(ideTextLines('{]'))[0].tokens.at(-1).className,'ide-bracket-invalid');
});
test('IDE search scans raw lines including invalid drafts without matching artificial line labels', async () => {
  assert.deepEqual((await searchData(['{"x":','"hello"','}'],'hello',{textLines:true})).hits,[[1]]);
  assert.deepEqual((await searchData(['text','words'],'0',{textLines:true})).hits,[]);
  assert.deepEqual((await searchData(['Cat','catalog'],'^cat$',{textLines:true,regex:true})).hits,[[0]]);
  assert.equal(await searchData(['text'],'text',{textLines:true,cancelled:()=>true}),null);
});
test('IDE formatting validates whole documents and preserves JSONL record boundaries', () => {
  assert.deepEqual(parseIdeText('{"a":2}', 'json').parsed,{a:2});
  assert.equal(formatIdeText('{"a":2}', 'json'),'{\n  "a": 2\n}\n');
  assert.equal(formatIdeText('{ "a": 1 }\r\n{ "b": "x\\ny" }', 'jsonl'),'{"a":1}\n{"b":"x\\ny"}\n');
  assert.throws(()=>formatIdeText('{"a":', 'json'));
  assert.throws(()=>formatIdeText('{"a":1}\nbad', 'jsonl'),/第 2 行/);
  assert.throws(()=>formatIdeText('', 'jsonl'),/至少/);
  assert.throws(()=>parseIdeText('{"n":1e400}', 'json'),/数字/);
});
test('IDE preference never overrides the memory threshold or indexed loading', () => {
  assert.equal(ideModel({...doc({x:1}),size:32*1024*1024+1},'ide',32),null);
  assert.equal(ideModel({...doc({x:1}),source:{indexed:true}},'ide',256),null);
  assert.ok(ideModel({...doc({x:1}),size:32*1024*1024},'ide',32));
  assert.equal(normalizeViewMode('unknown'),'tree');
  assert.equal(ideModel(doc({x:1}),'tree',64),null);
});
test('IDE lines preserve keys, values and source paths for search navigation', () => {
  const data=JSON.parse('{"<script>":["a\\nb",null,true,2],"__proto__":null}');
  const lines=ideModel(doc(data),'auto',64);
  assert.deepEqual(JSON.parse(lines.map(l=>l.text).join('\n')),data);
  assert.deepEqual(lines.find(l=>l.text.includes('a\\nb')).path,['<script>',0]);
});
test('automatic mode rejects complexity and all modes bound text and traversal', () => {
  const wide=doc(Array.from({length:2001},()=>0));
  assert.equal(ideModel(wide,'auto',64),null);
  assert.ok(ideModel(wide,'ide',64));
  assert.equal(ideModel(doc(Array.from({length:10001},()=>0)),'ide',64),null);
  assert.equal(ideModel(doc('x'.repeat(2*1024*1024)),'ide',64),null);
  let deep=0;for(let i=0;i<65;i++) deep={child:deep};
  assert.equal(ideModel(doc(deep),'ide',64),null);
});
