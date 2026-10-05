#!/usr/bin/env node
// 把 src/ 下共用的数据与代码内联成两个自包含页面：host.html、player.html。
// 产物不依赖任何外部资源，双击即可离线打开；部署到 Vercel 时也是这两个文件原样上传。
//
// 另外生成「动画测试版」：host-beta.html、player-beta.html、beta.html（入口）。
// 同一份源码，多内联一层动画与音效（src/fx/），存档改用 shelter-playtest-beta: 命名空间，
// 与正式版的存档互不影响；正式版的三个文件不受影响。
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
const BETA = [
  { template: 'src/host/host.html', out: 'host-beta.html' },
  { template: 'src/player/player.html', out: 'player-beta.html' },
];
const BANNER = '<!-- 此文件由 shelter/build.mjs 从 shelter/src/ 生成，请勿直接修改。 -->';

/** 必须命中的替换：模板改了而这里没跟上时直接报错，不会悄悄生成错的测试版。 */
function must(text, from, to, times = null) {
  const parts = typeof from === 'string' ? text.split(from) : null;
  const count = parts ? parts.length - 1 : (text.match(new RegExp(from.source, from.flags.includes('g') ? from.flags : from.flags + 'g')) || []).length;
  if (!count || (times != null && count !== times)) throw new Error(`测试版构建：找不到要替换的内容（${from}，命中 ${count} 次）`);
  return parts ? parts.join(to) : text.replace(from, to);
}

/** 测试版模板：多内联动画音效层，词典也带上它的文字。 */
function betaTemplate(t) {
  t = must(t, /<!-- inline:i18n ([^ ]+) -->/, (_, list) => `<!-- inline:i18n ${list},src/fx/fx.js -->`, 1);
  t = must(t, /<title>([^<]*)<\/title>/, '<title>$1 · 动画测试版</title>', 1);
  t = must(t, '</head>', '<!-- inline:css src/fx/fx.css -->\n</head>', 1);
  return must(t, '</body>', '<!-- inline:js src/fx/fx.js -->\n</body>', 1);
}

/** 测试版产物：存档换命名空间；玩家页发出的守夜链接指向 host-beta.html。 */
function betaOutput(html, out) {
  const own = out === 'host-beta.html' ? 'host' : 'player';
  html = must(html, `shelter-playtest:${own}`, `shelter-playtest-beta:${own}`);
  if (/shelter-playtest:(host|player)/.test(html)) throw new Error(`${out} 里还有正式版的存档键`);
  if (out === 'player-beta.html') {
    html = must(html, '/player(\\.html)?$/', '/player-beta(\\.html)?$/', 2);
    html = must(html, "'host.html'", "'host-beta.html'", 3);
  }
  return html;
}

/** 测试版入口：由 index.html 改出来，链接指向测试版页面，一键重置只清测试版数据。 */
function betaLanding() {
  let t = readFileSync(join(ROOT, 'index.html'), 'utf8');
  t = must(t, '<!doctype html>\n', '<!doctype html>\n<!-- 此文件由 shelter/build.mjs 从 shelter/index.html 生成，请勿直接修改。 -->\n', 1);
  t = must(t, '<title>避难所 Playtest</title>', '<title>避难所 Playtest · 动画测试版</title>', 1);
  t = must(t, "en: 'Shelter Playtest' }", "en: 'Shelter Playtest · FX beta' }", 1);
  t = must(t, '</style>', '  .beta-note { margin: 16px 0 0; padding: 10px 14px; border-radius: 10px; background: var(--teal-soft); color: var(--teal-strong); font-size: 15px; max-width: 640px; }\n  .beta-note a { color: inherit; font-weight: 650; white-space: nowrap; }\n</style>', 1);
  t = must(t, '<h1 data-en="Shelter Playtest">避难所 Playtest</h1>\n', '<h1 data-en="Shelter Playtest">避难所 Playtest</h1>\n' +
    '  <p class="beta-note"><span data-en="FX beta: the same game with animations and synthesized sound effects. Saves are kept apart from the regular version.">动画与音效测试版：玩法与正式版相同，多了动画和合成音效；存档与正式版分开保存，互不影响。</span> ' +
    '<a href="index.html" data-en="Back to the regular version →">回到正式版 →</a></p>\n', 1);
  t = must(t, 'href="host.html" data-page="host.html"', 'href="host-beta.html" data-page="host-beta.html"', 1);
  t = must(t, 'href="player.html" data-page="player.html"', 'href="player-beta.html" data-page="player-beta.html"', 1);
  t = must(t, "k.indexOf('shelter-playtest:') === 0 && k !== KEY", "k.indexOf('shelter-playtest-beta:') === 0", 1);
  t = must(t, 'Delete every Shelter Playtest save on this device', 'Delete every FX beta save on this device', 1);
  t = must(t, '删除这台设备上避难所 Playtest 的全部数据', '删除这台设备上动画测试版的全部数据', 1);
  return t;
}

/**
 * 英文词典：src/shared/i18n/*.tsv，每行「中文<TAB>English」，# 开头为注释。
 * \n、\t、\\ 为转义。同一个中文在多个文件里出现时，后读到的覆盖先读到的（文件按名字排序）。
 */
export function loadDictionary(only = null, dir = join(ROOT, 'src/shared/i18n'), skip = []) {
  const dict = {};
  const unescape = (t) => t.replace(/\\(n|t|\\)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'));
  const names = readdirSync(dir).filter((f) => f.endsWith('.tsv') && (!only || only.includes(f.replace(/\.tsv$/, ''))) && !skip.includes(f.replace(/\.tsv$/, ''))).sort();
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

function inline(templatePath, transform = (t) => t) {
  const template = transform(readFileSync(join(ROOT, templatePath), 'utf8'));
  // <!-- inline:i18n a.js,b.js --> 只内联这些源码里实际出现的词条（外加 zz-extra 补充词条），两个页面各带各的
  return template.replace(/<!-- inline:i18n ([^ ]+) -->/g, (_, list) => {
    const sources = list.split(',').map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
    const extra = loadDictionary(['zz-extra']);
    // 动画测试版的词条（fx.tsv）只进测试版页面，正式版页面保持不变
    const all = loadDictionary(null, undefined, list.split(',').includes('src/fx/fx.js') ? [] : ['fx']);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) build();

function build() {
const check = process.argv.includes('--check');
let stale = 0;
const outputs = PAGES.map((page) => ({ out: page.out, template: page.template, html: inline(page.template) }))
  .concat(BETA.map((page) => ({ out: page.out, template: page.template, html: betaOutput(inline(page.template, betaTemplate), page.out) })))
  .concat([{ out: 'beta.html', template: 'index.html', html: betaLanding() }]);
for (const page of outputs) {
  const html = page.html;
  if (/<!-- inline:/.test(html)) throw new Error(`${page.template} 还有未处理的 inline 占位`);
  if (/\b(src|href)=["']https?:/i.test(html)) throw new Error(`${page.out} 引用了外部资源`);
  const outPath = join(ROOT, page.out);
  if (check) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
    if (current !== html) {
      console.error(`✗ ${page.out} 与源码不一致，请运行 node shelter/build.mjs`);
      stale += 1;
    } else {
      console.log(`✓ ${page.out} 已是最新`);
    }
  } else {
    writeFileSync(outPath, html);
    console.log(`已生成 ${page.out}（${(Buffer.byteLength(html) / 1024).toFixed(1)} KB）`);
  }
}
if (stale) process.exit(1);
}
