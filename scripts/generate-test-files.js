// 生成手工验收用的大文件样本。输出目录默认 local-data/test-files（已被 .gitignore 忽略）。
//
//   node scripts/generate-test-files.js              # 全集，约 1.2 GB
//   node scripts/generate-test-files.js --quick      # 只生成 < 70 MB 的样本，约 600 MB
//   node scripts/generate-test-files.js --only jsonl-256mib,json-256mib
//   node scripts/generate-test-files.js --force      # 覆盖已存在文件
//
// 所有样本内容由固定规则生成，同样参数下可重复。
import { createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
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
  const head = `{"id":${String(i).padStart(6, '0')},"name":"row-${String(i).padStart(6, '0')}","pad":"`;
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
  '25-deep-129.json': { note: '129 层嵌套，应报"嵌套超过 128 层"', run: () => write('25-deep-129.json', deepDocument(129, true)) }
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

await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
const total = manifest.reduce((sum, item) => sum + (item.bytes || 0), 0);
console.log(`\n共 ${manifest.length} 个文件，合计 ${bytes(total)}`);
