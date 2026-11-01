// 生成手工验收用的大文件样本。输出目录默认 local-data/test-files（已被 .gitignore 忽略）。
//
//   node scripts/generate-test-files.js              # 全集，约 1.2 GB
//   node scripts/generate-test-files.js --quick      # 跳过两个 256 MiB 主样本，仍会生成数百 MB 数据
//   node scripts/generate-test-files.js --only jsonl-256mib,json-256mib
//   node scripts/generate-test-files.js --force      # 覆盖已存在文件
//
// 所有样本内容由固定规则生成，同样参数下可重复。
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIB = 1024 * 1024;
const args = process.argv.slice(2);
const flag = name => args.includes('--' + name);
const option = name => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};

const OUT = resolve(ROOT, option('out') || 'local-data/test-files');
const QUICK = flag('quick');
const FORCE = flag('force');
const ONLY = option('only')?.split(',').map(s => s.trim()).filter(Boolean);

const bytes = n => n >= MIB ? (n / MIB).toFixed(1) + ' MiB' : (n / 1024).toFixed(1) + ' KiB';

async function write(name, chunks) {
  const path = join(OUT, name);
  if (!FORCE) {
    const existing = await stat(path).catch(() => null);
    if (existing?.isFile()) {
      console.log(`  跳过 ${name}（已存在，${bytes(existing.size)}）`);
      return existing.size;
    }
  }
  const stream = createWriteStream(path);
  await pipeline(Readable.from(chunks), stream);
  const size = (await stat(path)).size;
  console.log(`  ${name.padEnd(30)} ${bytes(size).padStart(10)}`);
  return size;
}

// 把同步生成器按固定行数聚合成块，减少 chunk 数量。
async function* batched(makeLine, count, perChunk = 2000) {
  let buf = '';
  let n = 0;
  for (let i = 0; i < count; i++) {
    buf += makeLine(i);
    if (++n === perChunk) { yield buf; buf = ''; n = 0; }
  }
  if (buf) yield buf;
}

// 一段固定宽度的长文本，用于撑大单个字段而不用真的随机。
const filler = (n, seed = 0) => {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  let out = '';
  let i = seed;
  while (out.length < n) out += words[i++ % words.length] + ' ';
  return out.slice(0, n);
};

const row = (i, idWidth = 7) => {
  const id = String(i).padStart(idWidth, '0');
  return JSON.stringify({
    id: Number(id),
    name: 'user-' + id,
    email: `user${id}@example.test`,
    score: (i * 37) % 10000,
    active: i % 3 === 0,
    note: filler(24, i)
  });
};

// 128 字节定长行，用于精确控制总字节数。
const FIXED_LINE = 128;
const fixedLine = i => {
  const head = `{"id":${i},"name":"row-${String(i).padStart(6, '0')}","pad":"`;
  const tail = '","ok":true}\n';
  return head + 'x'.repeat(FIXED_LINE - head.length - tail.length) + tail;
};

const specs = {
  '01-jsonl-8mib.jsonl': {
    note: '内存模式对照（远低于 64 MiB 阈值），应无分页、可"展开全部"',
    size: 8 * MIB,
    run: () => write('01-jsonl-8mib.jsonl', batched(i => row(i) + '\n', 64000))
  },
  '02-jsonl-32mib.jsonl': {
    note: '内存模式对照（低于阈值），打开应明显快于索引模式',
    run: () => write('02-jsonl-32mib.jsonl', batched(i => row(i) + '\n', 254000))
  },
  '03-jsonl-boundary-64mib.jsonl': {
    note: '恰好 64 MiB（64×1024×1024 字节）。判定为 size > 阈值 才走索引，此文件应走内存模式',
    exact: 64 * MIB,
    run: () => write('03-jsonl-boundary-64mib.jsonl', batched(fixedLine, 64 * MIB / FIXED_LINE))
  },
  '04-jsonl-just-over-64mib.jsonl': {
    note: '64 MiB + 128 字节，刚越过阈值，应走索引模式（最小索引样本）',
    exact: 64 * MIB + FIXED_LINE,
    run: () => write('04-jsonl-just-over-64mib.jsonl', batched(fixedLine, 64 * MIB / FIXED_LINE + 1))
  },
  '05-jsonl-256mib.jsonl': {
    note: '主性能样本，206 万行 6 字段，约 256 MiB',
    run: () => write('05-jsonl-256mib.jsonl', batched(i => row(i) + '\n', 2060000))
  },
  '06-json-256mib.json': {
    note: '单 JSON 数组，约 200 万项 6 字段，约 256 MiB',
    run: () => write('06-json-256mib.json',
      closeArray(batched(i => (i ? ',' : '[') + row(i), 2000000, 1000)))
  },
  '07-json-wide-2m.json': {
    note: '单个对象约 260 万字段（越过 64 MiB），验证宽对象按键定位与外部归并建表',
    run: () => write('07-json-wide-2m.json', jsonObject(
      i => `"field_${String(i).padStart(7, '0')}":${i}`, 2950000))
  },
  '08-json-deep-120.json': {
    note: '120 层嵌套（低于 128 上限），内部填充约 70 MB',
    run: () => write('08-json-deep-120.json', deepDocument(120))
  },
  '09-jsonl-long-lines.jsonl': {
    note: '每 2000 行混入一条约 100 KiB 的长行（超过 64 KiB，走流式子树后备路径）',
    run: () => write('09-jsonl-long-lines.jsonl', longLineJsonl())
  },
  '10-jsonl-bad-lines.jsonl': {
    note: '混入 JSON 语法坏行与 # / // 注释行。非严格模式跳过并提示，严格模式拒绝整文件',
    run: () => write('10-jsonl-bad-lines.jsonl', badLineJsonl())
  },
  '11-jsonl-unicode.jsonl': {
    note: '中文、emoji、\\u 转义、UTF-16 代理对，约 70 MB',
    run: () => write('11-jsonl-unicode.jsonl', unicodeJsonl())
  },
  '12-json-duplicate-keys.json': {
    note: '对象内存在重复键。索引模式按该键路径读取应报"无法唯一定位"，不得返回错误值',
    run: () => write('12-json-duplicate-keys.json', duplicateKeyJson())
  },
  '13-json-huge-string.json': {
    note: '含一个约 20 MB 的单个字符串。卡片只显示 8 KiB 预览；全文/复制应提示超过 8 MiB 上限',
    run: () => write('13-json-huge-string.json', hugeStringJson())
  },
  '14-jsonl-search-targets.jsonl': {
    note: '60 万行，每 5 万行埋一个唯一标记 SEARCH_TARGET_001..012；另有高频词 alpha 用于测截断',
    run: () => write('14-jsonl-search-targets.jsonl', searchJsonl())
  },
  '20-small-10mib.json': {
    note: '普通小文件回归，10 MiB 数组',
    run: () => write('20-small-10mib.json', jsonArray(80000))
  },
  '21-empty.jsonl': { note: '0 字节，应提示"没有可解析的记录"', run: () => write('21-empty.jsonl', []) },
  '22-bad-syntax.json': { note: '根语法错误，应提示解析失败', run: () => write('22-bad-syntax.json', ['{"a":1,}']) },
  '23-crlf.jsonl': { note: 'CRLF 换行 5000 行，应正常解析', run: () => write('23-crlf.jsonl', crlfJsonl()) },
  '24-bom.jsonl': { note: '带 UTF-8 BOM 的 JSONL，应正常解析', run: () => write('24-bom.jsonl', bomJsonl()) },
  '25-deep-129.json': { note: '129 层嵌套，应报"嵌套超过 128 层"', run: () => write('25-deep-129.json', deepDocument(129, true)) },

  // 26–31：内容边界。全部小于 2 KiB，因而都走内存模式，可在 IDE 视图里编辑，
  // 用来补 01–25 覆盖不到的键名、数字、空容器、行形态与搜索开关。
  '26-edge-content.json': {
    note: '内容边界：特殊键名（点/空/纯数字/引号/反斜杠/换行/__proto__/仅大小写不同）、大整数与极端浮点、空容器、Unicode 转义。内存模式，IDE 视图可直接编辑',
    run: () => write('26-edge-content.json', [edgeContentJson()])
  },
  '27-search-modes.jsonl': {
    note: '搜索开关验收：大小写 / 全词 / 正则 / 范围内查找各自的正例与反例，约 20 行',
    run: () => write('27-search-modes.jsonl', [searchModesJsonl()])
  },
  '28-jsonl-mixed-rows.jsonl': {
    note: 'JSONL 行不是对象：数组行、标量行、null / true 行，验证记录列表与搜索不崩',
    run: () => write('28-jsonl-mixed-rows.jsonl', [mixedRowsJsonl()])
  },
  '29-duplicate-keys-small.json': {
    note: '小体积重复键。内存模式按 JSON.parse 取最后一个；保存回写后重复项丢失，用于确认这是已知行为',
    run: () => write('29-duplicate-keys-small.json', [duplicateSmallJson()])
  },
  '30-empty.json': { note: '0 字节 .json，与 21 的 .jsonl 走不同分支', run: () => write('30-empty.json', []) },
  '31-scalar-root.json': { note: '根值是字符串标量，既不是数组也不是对象', run: () => write('31-scalar-root.json', ['"just a string"\n']) }
};

// --- 各类文档生成器 ---------------------------------------------------------

async function* closeArray(source) {
  for await (const chunk of source) yield chunk;
  yield ']';
}

function* jsonObject(makePair, count) {
  yield '{';
  let buf = '';
  for (let i = 0; i < count; i++) {
    buf += (i ? ',' : '') + makePair(i);
    if (i % 2000 === 1999) { yield buf; buf = ''; }
  }
  if (buf) yield buf;
  yield '}';
}

function* jsonArray(count) {
  yield '[';
  let buf = '';
  for (let i = 0; i < count; i++) {
    buf += (i ? ',' : '') + row(i);
    if (i % 1000 === 999) { yield buf; buf = ''; }
  }
  if (buf) yield buf;
  yield ']';
}

function* deepDocument(depth, onlyDepth = false) {
  for (let i = 0; i < depth; i++) yield `{"level_${i}":`;
  if (onlyDepth) {
    yield '1';
  } else {
    yield '[';
    let buf = '';
    let n = 0;
    for (let i = 0; i < 600000; i++) {
      buf += (i ? ',' : '') + row(i);
      if (++n === 1000) { yield buf; buf = ''; n = 0; }
    }
    if (buf) yield buf;
    yield ']';
  }
  for (let i = 0; i < depth; i++) yield '}';
}

function* longLineJsonl() {
  let buf = '';
  for (let i = 0; i < 400000; i++) {
    buf += (i % 2000 === 0 ? `{"id":${i},"blob":"${filler(100 * 1024, i)}"}` : row(i)) + '\n';
    if (i % 500 === 499) { yield buf; buf = ''; }
  }
}

function* badLineJsonl() {
  let buf = '';
  for (let i = 0; i < 700000; i++) {
    if (i % 5000 === 0) buf += '{"broken": ,}\n';
    else if (i % 5000 === 1) buf += '# 这一行是注释\n';
    else if (i % 5000 === 2) buf += '// 这一行也是注释\n';
    else buf += row(i) + '\n';
    if (i % 500 === 499) { yield buf; buf = ''; }
  }
}

function* unicodeJsonl() {
  let buf = '';
  for (let i = 0; i < 600000; i++) {
    buf += JSON.stringify({
      id: i,
      text: i % 3 === 0 ? '中文测试数据·JSON Atlas 阅读器' : i % 3 === 1 ? 'emoji 😀🚀🌏 混排' : filler(30, i),
      escaped: i % 2 === 0 ? '\\u4e2d\\u6587' : '\\ud83d\\ude00',
      note: '带"引号"和\\反斜杠'
    }) + '\n';
    if (i % 500 === 499) { yield buf; buf = ''; }
  }
}

function* duplicateKeyJson() {
  yield '{"dup":1,"dup":2,"dup":3,';
  const source = jsonObject(i => `"field_${i}":${i}`, 3500000);
  let first = true;
  for (const chunk of source) {
    yield first ? chunk.slice(1) : chunk;
    first = false;
  }
}

function* hugeStringJson() {
  yield '{"meta":{"note":"单个约 20 MB 字符串"},"blob":"';
  const text = filler(MIB, 0);
  for (let i = 0; i < 20; i++) yield text;
  yield '",';
  let first = true;
  for (const chunk of jsonObject(i => `"field_${i}":${i}`, 2300000)) {
    yield first ? chunk.slice(1) : chunk;
    first = false;
  }
}

function* searchJsonl() {
  let buf = '';
  for (let i = 0; i < 600000; i++) {
    const marker = i % 50000 === 0 ? `,"marker":"SEARCH_TARGET_${String(i / 50000 + 1).padStart(3, '0')}"` : '';
    buf += row(i).slice(0, -1) + marker + '}\n';
    if (i % 500 === 499) { yield buf; buf = ''; }
  }
}

function* crlfJsonl() {
  let buf = '';
  for (let i = 0; i < 520000; i++) {
    buf += row(i) + '\r\n';
    if (i % 1000 === 999) { yield buf; buf = ''; }
  }
}

function* bomJsonl() {
  yield '\uFEFF';
  let buf = '';
  for (let i = 0; i < 520000; i++) {
    buf += row(i) + '\n';
    if (i % 1000 === 999) { yield buf; buf = ''; }
  }
}

// --- 内容边界样本（26–31）---------------------------------------------------
// 这些文件要小到手写也不累，重点在键名 / 数字 / 空容器 / 行形态，不在体量。
// 26 故意写成原始文本而不用 JSON.stringify：要点正是 -0、1.0 这类
// 经过 JS 序列化就会被抹平的写法，必须原样落盘。

const edgeContentJson = () => `{
  "_readme": "内容边界样本：看的是键名、数字与空容器，不是值本身。",
  "键名": {
    "中文键": "值",
    "a.b": "含点号，路径应编码为 [\\"a.b\\"]，不能拆成两级",
    "0": "纯数字字符串键，不能被当成数组下标",
    "": "空键",
    "[x]": "含方括号",
    "quote\\"key": "含双引号",
    "back\\\\slash": "含反斜杠",
    "line\\nbreak": "含换行",
    "tab\\tkey": "含制表符",
    "__proto__": "不应污染原型",
    "constructor": "不应覆盖构造函数",
    "Key": "大写 K",
    "key": "小写 k，与 Key 只差大小写"
  },
  "数字": {
    "safeMax": 9007199254740991,
    "unsafe": 9007199254740993,
    "uint64": 18446744073709551615,
    "negativeZero": -0,
    "onePointZero": 1.0,
    "tiny": 1e-7,
    "big": 1e21,
    "bigger": 1e23,
    "float": 0.1,
    "sum": 0.30000000000000004
  },
  "空容器": { "object": {}, "array": [] },
  "Unicode": {
    "cjk": "中文测试",
    "emoji": "😀🚀🌏",
    "escaped": "\\u4e2d\\u6587",
    "surrogate": "\\ud83d\\ude00",
    "combining": "e\\u0301"
  },
  "字面量": [true, false, null],
  "嵌套": { "a": { "b": { "c": [1, 2, 3] } } }
}
`;

// 每类开关都给正例和反例，便于一眼看出是"没匹配"还是"匹配错了"。
// 注意：note 里刻意不写出被测词本身（写成"正则三点""全词"），否则 note
// 会被同一个查询命中，反例全部失效。
function searchModesJsonl() {
  const line = (id, word, note) => JSON.stringify({ id, word, note });
  return [
    line(1, 'Alpha', '大小写：默认不敏感应命中；开启敏感后本行不应命中'),
    line(2, 'alpha', '大小写：敏感后只应命中本行，与首尾两行对照'),
    line(3, 'ALPHA', '大小写：敏感后本行不应命中'),
    line(4, 'cat', '全词：单数形式，应命中'),
    line(5, 'cats', '全词：复数形式，不应命中'),
    line(6, 'concatenate', '全词：词内包含，不应命中'),
    line(7, 'cat.', '全词：标点是词边界，应命中'),
    line(8, 'abc', '正则三点：应命中'),
    line(9, 'a-c', '正则三点：横杠不是点，转义点后本行不应命中'),
    line(10, 'aXc', '正则三点：应命中'),
    line(11, 'a c', '正则三点：空格也算任意字符，应命中'),
    line(12, 'emoji 😀 alpha', '全词：前面是空格、后面是行尾，应命中；正则匹配 emoji 也应命中'),
    line(13, '中文词 中文搜索', '中文按子串匹配，无词边界概念'),
    line(14, 'SEARCH_TARGET_001', '唯一标记：搜全串应只命中本行'),
    line(15, 'alpha alpha alpha', '同一行三次命中，结果只应出现一次'),
    line(16, '$ ^ ( ) [ ] { } * + ? | .', '正则元字符：普通搜索应按字面命中整行，不应报错'),
    line(17, '范围外 BETA', '范围内查找：不在 scope 子节点内'),
    JSON.stringify({ id: 18, scope: { hit: 'BETA 在范围内', miss: 'gamma' }, note: '范围内查找：只作用于 scope 节点' }),
    line(19, '', '空字符串值：搜空串不应返回全量'),
    line(20, 'end', '末行哨兵'),
    line(21, 'a.c', '正则三点：字面点，转义点后只应命中本行')
  ].join('\n') + '\n';
}

// JSONL 的行不一定是对象。数组行、标量行、null / true 行都要能进记录列表。
const mixedRowsJsonl = () => [
  '{"id":1,"kind":"object"}',
  '[1,2,3]',
  '"bare string row"',
  '42',
  'null',
  'true',
  '{"id":2,"kind":"object again"}',
  '[[1,2],[3,4]]'
].join('\n') + '\n';

// 与 12 同一个问题，但小到内存模式：JSON.parse 只保留最后一个，
// 保存回写后中间的 1、2 会消失——这是已知行为，需要有人认领过。
const duplicateSmallJson = () => '{"dup":1,"dup":2,"dup":3,"nested":{"x":1,"x":2},"keep":"ok"}\n';

// --- 主流程 ---------------------------------------------------------------

await mkdir(OUT, { recursive: true });
console.log(`输出目录：${OUT}`);
console.log(QUICK ? '模式：quick（跳过 256 MiB 主样本）\n' : '模式：full\n');

const manifest = [];
for (const [name, spec] of Object.entries(specs)) {
  if (ONLY && !ONLY.some(prefix => name.startsWith(prefix))) continue;
  if (QUICK && /256mib/.test(name)) continue;
  const started = Date.now();
  try {
    const size = await spec.run();
    manifest.push({ name, note: spec.note, bytes: size, exact: spec.exact ?? null });
    if (size) console.log(`  ${' '.repeat(30)} ${String(Date.now() - started).padStart(5)} ms`);
  } catch (error) {
    console.error(`  ${name} 生成失败：${error.message}`);
    process.exitCode = 1;
  }
}

// 只生成一部分样本时不能把整份 manifest 覆盖掉，按文件名合并。
const manifestPath = join(OUT, 'manifest.json');
const previous = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '[]'));
const merged = new Map(Array.isArray(previous) ? previous.map(item => [item.name, item]) : []);
for (const item of manifest) merged.set(item.name, item);
const all = [...merged.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
await writeFile(manifestPath, JSON.stringify(all, null, 2), 'utf8');
const total = all.reduce((sum, item) => sum + (item.bytes || 0), 0);
console.log(`\n本次 ${manifest.length} 个文件；目录清单共 ${all.length} 个，合计 ${bytes(total)}`);
