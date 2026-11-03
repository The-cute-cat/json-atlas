import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Only generated output is replaced. site/ remains the editable page source.
const output = resolve('dist/site');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const file of ['index.html', 'style.css']) cpSync(resolve('site', file), resolve(output, file));
cpSync(resolve('assets'), resolve(output, 'assets'), { recursive: true });
cpSync(resolve('dist/json-atlas.html'), resolve(output, 'app.html'));
console.log('站点已生成：dist/site/（介绍页、图片与独立试用页）');
