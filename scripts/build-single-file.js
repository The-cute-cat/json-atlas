#!/usr/bin/env node
/**
 * 把 Vite 的浏览器构建产物内联成一个自包含的 HTML 文件。
 *
 * 用法：node scripts/build-single-file.js [构建目录] [输出文件]
 * 默认：temp/single-build -> dist/json-atlas.html
 *
 * 内联内容：样式表、入口脚本、图标、以及两个 Web Worker（转成 data URL）。
 * 产物可以直接双击用 file:// 打开，不需要本地服务器。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const input = path.resolve(process.argv[2] || 'temp/single-build');
const output = path.resolve(process.argv[3] || 'dist/json-atlas.html');
const htmlPath = path.join(input, 'index.html');

if (!fs.existsSync(htmlPath)) {
  console.error(`找不到构建产物：${htmlPath}\n请先运行 npm run build:single`);
  process.exit(1);
}

let html = fs.readFileSync(htmlPath, 'utf8');
const read = rel => fs.readFileSync(path.join(input, rel), 'utf8');
const escapeInline = text => text.replace(/<\/script/gi, '<\\/script').replace(/<\/style/gi, '<\\/style');
let styles = 0, entries = 0;

// 1. 样式表 -> <style>
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (tag, href) => {
  if (!href.startsWith('./assets/')) return tag;
  styles++;
  return `<style>\n${escapeInline(read(href))}\n</style>`;
});

// 2. 图标 -> data URI
const icons = new Map();
html = html.replace(/(href|src)="\.\/assets\/([\w.-]+\.png)"/g, (tag, attr, file) => {
  if (!icons.has(file)) {
    icons.set(file, `data:image/png;base64,${fs.readFileSync(path.join(input, 'assets', file)).toString('base64')}`);
  }
  return `${attr}="${icons.get(file)}"`;
});

// 3. Vite emits self-contained workers. data URLs also work for module workers
// opened from file://, where Blob module URLs fail in Chromium.
const workerFiles = fs.readdirSync(path.join(input, 'assets')).filter(f => /^(parser|search)\.worker-[\w-]+\.js$/.test(f));
if (workerFiles.length !== 2) throw new Error('预期 parser 和 search 两个 Worker，请检查 Vite 构建输出');
const workerUrls = Object.fromEntries(workerFiles.map(file => [file,
  'data:text/javascript;base64,' + Buffer.from(read(`assets/${file}`)).toString('base64')]));
const prelude = `const __inlineWorkerUrls = ${JSON.stringify(workerUrls)};\n`;

function inlineWorkers(js) {
  let out = js;
  for (const file of workerFiles) {
    const reference = `new URL("${file}",import.meta.url).href`;
    if (!out.includes(reference)) throw new Error(`无法内联 Worker ${file}，Vite 输出格式可能已改变`);
    // new URL("<worker>", import.meta.url).href -> 内联的 data URL
    out = out.replaceAll(reference, `__inlineWorkerUrls["${file}"]`);
    // 外层包装 new URL("" + <data url>, import.meta.url) 对绝对 URI 是恒等变换，直接去掉
    out = out.replace(/new URL\(""\+(__inlineWorkerUrls\["[^"]+"\]),import\.meta\.url\)/g, '$1');
  }
  return out;
}

// 4. 入口脚本 -> 内联 module
html = html.replace(/<script[^>]*type="module"[^>]*src="\.\/assets\/([\w.-]+\.js)"[^>]*><\/script>/g, (tag, file) => {
  entries++;
  const js = inlineWorkers(read(`assets/${file}`));
  return `<script type="module">\n${escapeInline(prelude + js)}\n</script>`;
});

// 5. 自检：不应残留任何本地资源引用
const leftovers = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map(m => m[1]);
if (leftovers.length) {
  console.error(`仍有未内联的引用：\n${leftovers.join('\n')}`);
  process.exit(1);
}
if (styles !== 1 || entries !== 1) throw new Error('预期一个入口脚本和一个样式表，请检查构建格式');
if (/import\.meta\.url/.test(html)) {
  console.error('仍有未改写的 Worker URL');
  process.exit(1);
}

// 6. 标注来源：这是构建产物，不是可以直接手改的原型
const banner = `<!--
  JSON Atlas 单文件版：由 src/ 构建生成，请勿直接编辑本文件。
  重新生成：npm run build:single
  源码与桌面版共用，桌面特有功能（磁盘索引、原生读写、菜单、文件关联）在浏览器中不可用。
  Worker 以 data URL 内联；解析与正则搜索保持在后台线程运行。
-->`;
html = html.replace('<!DOCTYPE html>', `<!DOCTYPE html>\n${banner}`);

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`已生成 ${path.relative(process.cwd(), output)}（${kb} KB，内联 ${icons.size} 个图标、${workerFiles.length} 个 Worker）`);
