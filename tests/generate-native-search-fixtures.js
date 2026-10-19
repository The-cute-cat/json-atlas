// Rebuild only when the established JavaScript matching semantics change.
import { writeFileSync } from 'node:fs';
import { searchData } from '../src/data.js';
import { compileSearch } from '../src/search-pattern.js';
const cases = [];
const texts = [
  '{"g":["ΟΣ","ΟΣΑ","Σ","AΣ́","AΣ́A","İSTANBUL","😀中文","AΣ\\u0301\\u0027A"],"空 格":"秘密","rows":[{"secret":"hidden","text":"needle"},{"secret":"hidden","text":"tail"}]}',
  '[-0,1.0,1e-6,1e-7,1e20,1e21,1e23,9007199254740993,18446744073709551615,1000000000000000128,0.0000012345,true,null,{},[]]',
];
for (const text of texts) {
  for (const query of ['ος', 'οσ', 'σ', 'ς', 'σ́a', 'i̇', '😀中', '秘密', 'needle', 'hidden', 'tail', 'array', 'object', '0', '1e+', '1e-', '9007199254740992', '18446744073709552000', '1000000000000000100', 'true', 'null', 'missing']) {
    for (const settings of [{}, { hidden: ['$.rows[0].secret', '$["空 格"]'], indexBase: 1, rootLabel: '我的根' }, { limit: 1 }]) {
      const options = { ...settings, hidden: new Set(settings.hidden || []) };
      const expected = await searchData(JSON.parse(text), query, options);
      cases.push({ text, options: { searchId: 'fixture', query, ...settings }, expected });
    }
  }
}
const advanced = JSON.stringify({ words: ['Cat', 'cat', 'catalog', '汉字', '汉字库', 'ΟΣ', 'Σ', 'K', 'ſ', 'user-42', 'tail', '', 'aaab', '😀', 'a&&b', '[', '-', '\u0001', '\u0000', '\u0008', '\n\r\u2028\u2029\ufeff'], hidden: 'cat' });
for (const query of ['Cat', 'cat', '\\bcat\\b', 'user-\\d{2}\\b', '^root', 'tail$', '.', '\\s+', '\\S+', '\\D+', '\\w+', '\\W+', 'a{2,4}', '(?:ab|aba)+?', '(?:x?)*', '^$', '\\p{L}{2}', '\\uD83D\\uDE00', '[a&&b]+', '[[]', '[--]', '[]', '[^]', '[\\dA-F]+', '\\cA', '\\0', '[\\b]', '(?:foo)?', '(?:a|)b', '汉字', '\\bk\\b', '\\bs\\b']) {
  for (const caseSensitive of [false, true]) for (const wholeWord of [false, true]) {
    const settings = { regex: true, caseSensitive, wholeWord, hidden: new Set(['$.hidden']) };
    const { nativePattern } = compileSearch(query, settings);
    cases.push({ text: advanced, options: { searchId: 'fixture', query, caseSensitive, nativePattern, hidden: [...settings.hidden] }, expected: await searchData(JSON.parse(advanced), query, settings) });
  }
}
for (const query of ['Cat', '汉字', 'user-42', '.*']) for (const caseSensitive of [false, true]) {
  const settings = { caseSensitive, wholeWord: true }, { nativePattern } = compileSearch(query, settings);
  cases.push({ text: advanced, options: { searchId: 'fixture', query, caseSensitive, nativePattern }, expected: await searchData(JSON.parse(advanced), query, settings) });
}
for (const scopePath of [['words'], ['words', 2], ['hidden'], ['missing'], []]) {
  const settings = { regex: true, wholeWord: true, scopePath, hidden: new Set(['$.hidden']) }, query = 'cat|dog';
  cases.push({ text: advanced, options: { searchId: 'fixture', query, ...settings, hidden: [...settings.hidden], nativePattern: compileSearch(query, settings).nativePattern }, expected: await searchData(JSON.parse(advanced), query, settings) });
}
writeFileSync(new URL('./native-search-fixtures.json', import.meta.url), '[\n' + cases.map(c => JSON.stringify(c)).join(',\n') + '\n]\n');
const numbers = ['-0', '1.0000000000000001', '2.2250738585072012e-308', '1000000000000000128'];
const bytes = new DataView(new ArrayBuffer(8));
let state = 123456789n;
for (let i = 0; i < 3000; i++) {
  state = BigInt.asUintN(64, state * 6364136223846793005n + 1442695040888963407n);
  bytes.setBigUint64(0, state);
  const value = bytes.getFloat64(0);
  if (Number.isFinite(value)) numbers.push(String(value));
}
writeFileSync(new URL('./native-search-numbers.json', import.meta.url), JSON.stringify(numbers.map(raw => [raw, String(Number(raw))])) + '\n');
