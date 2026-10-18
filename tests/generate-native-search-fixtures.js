// Rebuild only when the established JavaScript matching semantics change.
import { writeFileSync } from 'node:fs';
import { searchData } from '../src/data.js';
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
