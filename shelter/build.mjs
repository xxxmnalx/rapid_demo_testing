#!/usr/bin/env node
// 把 src/ 下共用的数据与代码内联成两个自包含页面：host.html、player.html。
// 产物不依赖任何外部资源，双击即可离线打开；部署到 Vercel 时也是这两个文件原样上传。
// 另外把局域网联机服务器（lan/server.mjs + relay/src/room.js + 三个页面）打成单个文件 shelter-lan.mjs，
// 主持人下载后 node shelter-lan.mjs 就能在自己电脑上开局域网房间。
//
//   node build.mjs          生成
//   node build.mjs --check  只检查产物是否与源码一致（不一致时退出码 1）

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PAGES = [
  { template: 'src/host/host.html', out: 'host.html' },
  { template: 'src/player/player.html', out: 'player.html' },
];
const BANNER = '<!-- 此文件由 shelter/build.mjs 从 shelter/src/ 生成，请勿直接修改。 -->';

/**
 * 英文词典：src/shared/i18n/*.tsv，每行「中文<TAB>English」，# 开头为注释。
 * \n、\t、\\ 为转义。同一个中文在多个文件里出现时，后读到的覆盖先读到的（文件按名字排序）。
 */
export function loadDictionary(only = null, dir = join(ROOT, 'src/shared/i18n')) {
  const dict = {};
  const unescape = (t) => t.replace(/\\(n|t|\\)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'));
  const names = readdirSync(dir).filter((f) => f.endsWith('.tsv') && (!only || only.includes(f.replace(/\.tsv$/, '')))).sort();
  for (const name of names) {
    readFileSync(join(dir, name), 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim() || line.startsWith('#')) return;
      const tab = line.indexOf('\t');
      if (tab < 0) throw new Error(`${name}:${i + 1} 缺少制表符`);
      const zh = unescape(line.slice(0, tab));
      const en = unescape(line.slice(tab + 1));
      if (en === '' || en === '~') return; // 空＝还没翻译；~＝交给 i18n.js 的固定句式处理（如量词）
      dict[zh] = en;
    });
  }
  return dict;
}

function inline(templatePath) {
  const template = readFileSync(join(ROOT, templatePath), 'utf8');
  // <!-- inline:i18n a.js,b.js --> 只内联这些源码里实际出现的词条（外加 zz-extra 补充词条），两个页面各带各的
  return template.replace(/<!-- inline:i18n ([^ ]+) -->/g, (_, list) => {
    const sources = list.split(',').map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
    const extra = loadDictionary(['zz-extra']);
    const all = loadDictionary();
    const esc = (k) => k.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/'/g, "\\'");
    const dict = {};
    for (const [k, v] of Object.entries(all)) if (k in extra || sources.includes(k) || sources.includes(esc(k))) dict[k] = v;
    const json = JSON.stringify(dict).replace(/<\/script/gi, '<\\/script');
    return `<script>\n/* src/shared/i18n/*.tsv（${Object.keys(dict).length} 条） */\nwindow.SHELTER_I18N_EN = ${json};\n</script>`;
  }).replace(/<!-- inline:(css|js) ([^ ]+) -->/g, (_, kind, file) => {
    const source = readFileSync(join(ROOT, file), 'utf8').trimEnd();
    if (kind === 'css') {
      if (/<\/style/i.test(source)) throw new Error(`${file} 含有 </style，无法内联`);
      return `<style>\n/* ${file} */\n${source}\n</style>`;
    }
    // 防止脚本里出现的 </script 提前结束标签
    return `<script>\n/* ${file} */\n${source.replace(/<\/script/gi, '<\\/script')}\n</script>`;
  }).replace(/^<!doctype html>\n/i, (m) => m + BANNER + '\n');
}

/**
 * 局域网服务器单文件版：把 room.js 的内容替换掉 import 那一行（去掉 export），
 * 把三个页面作为字符串嵌进去，替换掉「从磁盘读页面」那一行。只用 Node 自带模块，不需要 npm install。
 */
export function bundleLan(pages) {
  const server = readFileSync(join(ROOT, 'lan/server.mjs'), 'utf8');
  const room = readFileSync(join(ROOT, 'relay/src/room.js'), 'utf8').replace(/^export (?=const|function|class)/gm, '');
  const importLine = /^import \{[^}]*\} from '\.\.\/relay\/src\/room\.js'; \/\/ @@ROOM@@$/m;
  const pagesLine = /^const PAGES = loadPagesFromDisk\(\); \/\/ @@PAGES@@$/m;
  if (!importLine.test(server) || !pagesLine.test(server)) throw new Error('lan/server.mjs 里找不到 @@ROOM@@ 或 @@PAGES@@ 标记');
  const embedded = '{\n' + Object.keys(pages).map((k) => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(pages[k])).join(',\n') + '\n}';
  return server
    .replace(importLine, () => '// ---------------------------------------------------------------- 房间逻辑（relay/src/room.js）\n' + room.trim() + '\n// ---------------------------------------------------------------- 房间逻辑结束')
    .replace(pagesLine, () => 'const PAGES = ' + embedded + ';')
    .replace(/^#!\/usr\/bin\/env node\n/, (m) => m + '// 此文件由 shelter/build.mjs 从 shelter/lan/server.mjs、shelter/relay/src/room.js 和构建好的页面生成，请勿直接修改。\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) build();

function build() {
const check = process.argv.includes('--check');
let stale = 0;
const built = { '/index.html': readFileSync(join(ROOT, 'index.html'), 'utf8') };
const outputs = [];
for (const page of PAGES) {
  const html = inline(page.template);
  built['/' + page.out] = html;
  if (/<!-- inline:/.test(html)) throw new Error(`${page.template} 还有未处理的 inline 占位`);
  if (/\b(src|href)=["']https?:/i.test(html)) throw new Error(`${page.out} 引用了外部资源`);
  outputs.push({ out: page.out, text: html });
}
outputs.push({ out: 'shelter-lan.mjs', text: bundleLan(built) });
for (const { out, text } of outputs) {
  const outPath = join(ROOT, out);
  if (check) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
    if (current !== text) {
      console.error(`✗ ${out} 与源码不一致，请运行 node shelter/build.mjs`);
      stale += 1;
    } else {
      console.log(`✓ ${out} 已是最新`);
    }
  } else {
    writeFileSync(outPath, text);
    console.log(`已生成 ${out}（${(Buffer.byteLength(text) / 1024).toFixed(1)} KB）`);
  }
}
if (stale) process.exit(1);
}
