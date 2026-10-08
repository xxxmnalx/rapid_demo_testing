// 联机端到端：局域网服务器 + 真实浏览器（主持人一个、玩家两个），走一遍联机时的主要往来。
// 运行：cd shelter && npm run test:net
// 需要 Playwright 的 Chromium；页面由 lan/server.mjs 提供（和正式的局域网版同一套房间逻辑）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../lan/server.mjs';

const HOST_DEMO = 'shelter-playtest:host-demo:v1';
const PLAYER_KEY = 'shelter-playtest:player:v1';
const P = (n) => 'demo_p' + n; // A..F = 1..6

let browser;
let server;
let base;
let dataDir;

before(async () => {
  dataDir = mkdtempSync(pathJoin(tmpdir(), 'shelter-net-'));
  server = startServer({ port: 0, host: '127.0.0.1', data: pathJoin(dataDir, 'rooms.json'), quiet: true });
  await new Promise((res) => server.on('listening', res));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
  await new Promise((res) => server.close(res));
  rmSync(dataDir, { recursive: true, force: true });
});

async function open(context, url) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  await page.waitForSelector('#tabs .tab');
  return { page, errors };
}

async function tab(page, id) {
  const target = page.locator(`[data-tab="${id}"]`);
  if (!(await target.isVisible())) await page.click('.more-btn');
  await target.click();
}
const modal = (page) => page.locator('.modal');
const modalBtn = (page, name) => modal(page).getByRole('button', { name, exact: true }).click();
const btn = (page, name) => page.getByRole('button', { name, exact: true });
const read = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
/** 等存档满足条件（联机消息是异步到的）。 */
async function until(page, key, pred, label) {
  for (let i = 0; i < 100; i++) {
    const s = await read(page, key);
    if (s && pred(s)) return s;
    await page.waitForTimeout(100);
  }
  throw new Error('timeout: ' + label);
}

async function reveal(page, key, show = '显示') {
  await page.locator(`[data-gate="${key}"] button`).click();
  await page.check('#confirm-share-paused');
  await modalBtn(page, show);
  await page.locator(`[data-gate-open="${key}"]`).waitFor();
}

/** 玩家用加入链接进房间，选自己的名字（主持人默认自动通过）。 */
async function join(context, link, name) {
  const { page, errors } = await open(context, link.replace(/^https?:\/\/[^/]+/, base));
  await page.locator('.net-roster button', { hasText: name }).click();
  await page.locator('.pn-live').first().waitFor();
  await until(page, PLAYER_KEY, (s) => s.name === name, name + ' 同步名字');
  return { page, errors };
}

test('联机：加入、公开信息同步、领补给自动入库与撤回、赠予与交公、投票、行动自动记录、私信与离线补收、守夜卡直达', async () => {
  const hostCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const { page: host, errors: hostErrors } = await open(hostCtx, base + '/host.html');
  await tab(host, 'settings');
  await btn(host, '打开演示存档').click();
  await host.waitForFunction((k) => !!localStorage.getItem(k), HOST_DEMO);

  // 开房间
  await tab(host, 'net');
  await btn(host, '开房间').click();
  await host.locator('.net-code').waitFor();
  const code = (await host.textContent('.net-code')).trim();
  assert.match(code, /^[2-9A-HJKMNP-Z]{5}$/);
  const link = await host.locator('.net-room textarea.copy-text').inputValue();
  assert.ok(link.endsWith('/player.html#join=' + code), '加入链接指向玩家页');
  assert.ok(await host.locator('.net-qr svg').isVisible(), '有二维码');
  await host.locator('.net-chip.st-online').waitFor();

  // 两位玩家加入（甲＝A·老陈，乙＝B·阿珍）
  const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page: a, errors: aErrors } = await join(ctxA, link, 'A·老陈');
  const { page: b, errors: bErrors } = await join(ctxB, link, 'B·阿珍');
  await host.locator('tr[data-net-player="' + P(1) + '"]', { hasText: '已加入 · 在线' }).waitFor();
  await host.locator('tr[data-net-player="' + P(2) + '"]', { hasText: '已加入 · 在线' }).waitFor();
  let sa = await until(a, PLAYER_KEY, (s) => s.otherNames.length === 5, '名单同步');
  assert.ok(sa.otherNames.includes('F·教授') && !sa.otherNames.includes('A·老陈'), '守夜卡名单＝主持人名单里的其他人');
  assert.equal(sa.publicInfo.seat, '1', '座次同步');
  await until(a, PLAYER_KEY, (s) => (s.inbox || []).some((x) => /规则包/.test(x.text)), '规则包自动导入');

  // 开始第 1 天：玩家页天数自动同步
  await tab(host, 'flow');
  await btn(host, '开始第 1 天 →').click();
  await modalBtn(host, '开始');
  await until(a, PLAYER_KEY, (s) => s.publicInfo.day === 1, '天数同步');
  await a.locator('.pn-phase', { hasText: '第 1 天' }).waitFor();

  // 资源补给：主持人抽 6 件，轮到甲时甲的页面出现候选，点一件领取 → 自动入库
  await host.locator('.top-actions .btn.primary').click();
  await tab(host, 'supply');
  await reveal(host, 'pool');
  await btn(host, '抽取').click();
  let hs = await read(host, HOST_DEMO);
  const batch = hs.batches.at(-1);
  assert.deepEqual(batch.pickOrder.slice(0, 2), [P(1), P(2)]);
  await tab(a, 'dashboard');
  const offer = a.locator('.pn-offer');
  await offer.waitFor();
  const pieceA = batch.items[0];
  await offer.locator(`[data-piece="${pieceA.id}"]`).click();
  await modalBtn(a, '领取');
  sa = await until(a, PLAYER_KEY, (s) => s.inventory.some((e) => e.src === 'g-' + batch.id + '-' + pieceA.id), '甲的补给入库');
  assert.ok(sa.inbox.some((x) => x.kind === 'grant'), '收件箱记一笔');
  hs = await until(host, HOST_DEMO, (s) => s.batches.at(-1).picks.length === 1, '主持人页记录领取');
  assert.equal(hs.batches.at(-1).picks[0].playerId, P(1));

  // 轮到乙：乙在自己的页面领取；主持人撤回乙的领取 → 乙的库存自动扣回
  await tab(b, 'dashboard');
  await b.locator('.pn-offer').waitFor();
  const pieceB = hs.batches.at(-1).items[0];
  await b.locator(`.pn-offer [data-piece="${pieceB.id}"]`).click();
  await modalBtn(b, '领取');
  let sb = await until(b, PLAYER_KEY, (s) => s.inventory.some((e) => e.src === 'g-' + batch.id + '-' + pieceB.id), '乙的补给入库');
  const countB = sb.inventory.reduce((n, e) => n + e.qty, 0);
  await host.locator(`tr[data-picker="${P(2)}"]`).getByRole('button', { name: '撤回' }).click();
  sb = await until(b, PLAYER_KEY, (s) => s.inventory.reduce((n, e) => n + e.qty, 0) === countB - 1, '撤回后乙的库存扣回');
  assert.ok(sb.inbox.some((x) => x.kind === 'revoke'));
  // 乙重新领（又轮到乙了）
  await b.locator('.pn-offer [data-piece]').first().waitFor();
  await b.locator('.pn-offer [data-piece]').first().click();
  await modalBtn(b, '领取');
  sb = await until(b, PLAYER_KEY, (s) => s.inventory.reduce((n, e) => n + e.qty, 0) === countB, '乙重新领到');
  // 主持人用顶栏「撤销」撤掉自己之后的操作，不会撤掉玩家页领取
  hs = await until(host, HOST_DEMO, (s) => s.batches.at(-1).picks.length === 2, '主持人页两笔领取');

  // 甲把领到的物品赠予乙：甲扣、乙加；主持人页留日志
  const giftEntry = sa.inventory.find((e) => e.src === 'g-' + batch.id + '-' + pieceA.id);
  const qtyOf = (st, defId) => st.inventory.filter((e) => e.defId === defId).reduce((n, e) => n + e.qty, 0);
  const bHad = qtyOf(sb, giftEntry.defId);
  await tab(a, 'inventory');
  await a.locator(`[data-entry="${giftEntry.id}"]`).getByRole('button', { name: '赠予／交公' }).click();
  await modal(a).locator('select').first().selectOption(P(2));
  await modalBtn(a, '转出');
  sa = await until(a, PLAYER_KEY, (s) => !s.inventory.some((e) => e.id === giftEntry.id) && !Object.keys(s.netData.outgoing).length, '甲扣掉、房间收下');
  sb = await until(b, PLAYER_KEY, (s) => s.inbox.some((x) => x.kind === 'gift'), '乙收到赠予');
  assert.equal(qtyOf(sb, giftEntry.defId), bHad + 1, '乙的库存加上同一件');
  await until(host, HOST_DEMO, (s) => s.log.some((l) => /赠予 B·阿珍/.test(l.text)), '主持人页留副本');

  // 乙交公：乙扣、公共池加
  const poolBefore = (await read(host, HOST_DEMO)).pool.reduce((n, e) => n + e.qty, 0);
  const depositEntry = sb.inventory.find((e) => e.defId === giftEntry.defId);
  await tab(b, 'inventory');
  await b.locator(`[data-entry="${depositEntry.id}"]`).getByRole('button', { name: '赠予／交公' }).click();
  await modal(b).getByRole('button', { name: '交给公共池' }).click();
  await modalBtn(b, '转出');
  hs = await until(host, HOST_DEMO, (s) => s.pool.reduce((n, e) => n + e.qty, 0) === poolBefore + 1, '公共池加 1');
  sb = await until(b, PLAYER_KEY, (s) => qtyOf(s, giftEntry.defId) === bHad, '乙扣掉');
  await btn(host, '结束批次（未选的放回公共池）').click();
  await btn(host, '一键隐藏所有秘密').click();

  // 公共事件：在玩家页投票，主持人结束投票并采用多数
  await tab(host, 'events');
  await reveal(host, 'events');
  hs = await read(host, HOST_DEMO);
  const ev = hs.events.find((e) => e.name.includes('售货机'));
  await host.locator('select', { has: host.locator('option', { hasText: '手动选择事件…' }) }).selectOption(ev.id);
  await btn(host, '使用所选事件').click();
  await host.locator('.flow-steps').getByRole('button', { name: '公布到公开页' }).click();
  await btn(host, '在玩家页面发起投票').click();
  await tab(a, 'dashboard');
  await tab(b, 'dashboard');
  const optA = ev.options[0];
  const optB = ev.options[1];
  await a.locator(`[data-vote="${optA.id}"]`).click();
  await b.locator(`[data-vote="${optB.id}"]`).click();
  await b.locator(`[data-vote="${optA.id}"]`).click(); // 改票
  hs = await until(host, HOST_DEMO, (s) => s.today.eventFlow.netVote && Object.keys(s.today.eventFlow.netVote.ballots).length === 2 && s.today.eventFlow.netVote.ballots[P(2)] === optA.id, '两票到齐（乙改了票）');
  await a.locator('.pn-vote', { hasText: '已投 2／6' }).waitFor();
  await btn(host, '结束投票并采用结果').click();
  hs = await read(host, HOST_DEMO);
  assert.equal(hs.today.eventFlow.vote, optA.id, '按多数票录入');
  await a.locator('.pn-vote', { hasText: '投票结束' }).waitFor();
  assert.ok((await a.locator(`[data-vote="${optA.id}"]`).innerText()).includes('2 票'), '结束后玩家页显示票数');

  // 结算后把结果发到玩家页：甲在收件箱点「应用」，自己的生命按个人效果改
  const shock = optA.outcomes.find((o) => o.effects.personal && o.effects.personal.hp === -1);
  await host.locator('select', { has: host.locator('option', { hasText: '手动选择结果…' }) }).selectOption(shock.id);
  await btn(host, '手动指定').click();
  await btn(host, '确认结算').click();
  await btn(host, '发到玩家页（可一键应用个人效果）').click();
  await modal(host).locator('label.check', { hasText: 'A·老陈' }).locator('input').check();
  await modalBtn(host, '发送');
  sa = await until(a, PLAYER_KEY, (s) => s.inbox.some((x) => x.kind === 'effect'), '甲收到事件结果');
  const hpBefore = sa.hp;
  await tab(a, 'net');
  await a.getByRole('button', { name: '应用到我的存档' }).click();
  sa = await until(a, PLAYER_KEY, (s) => s.hp === hpBefore - 1, '甲应用个人效果：生命 -1');
  assert.ok(sa.inbox.find((x) => x.kind === 'effect').applied);
  await a.locator('.pn-msg.k-effect .chip.ok', { hasText: '已应用' }).waitFor();
  await btn(host, '一键隐藏所有秘密').click();

  // 乙对甲用绷带：乙的绷带扣掉，甲的页面自动 +1 生命
  await tab(b, 'inventory');
  await b.getByRole('button', { name: '+ 添加物品' }).click();
  await modal(b).locator('select').first().selectOption('bandage');
  await modalBtn(b, '添加');
  sb = await until(b, PLAYER_KEY, (s) => s.inventory.some((e) => e.defId === 'bandage'), '乙有绷带');
  const bandage = sb.inventory.find((e) => e.defId === 'bandage');
  await b.locator(`[data-entry="${bandage.id}"]`).getByRole('button', { name: '使用' }).click();
  await modal(b).getByRole('button', { name: '他人', exact: true }).click();
  await modal(b).locator('select').first().selectOption(P(1));
  await modalBtn(b, '使用');
  sa = await until(a, PLAYER_KEY, (s) => s.hp === hpBefore && s.inbox.some((x) => x.kind === 'heal'), '甲被治疗：生命 +1');
  sb = await until(b, PLAYER_KEY, (s) => !s.inventory.some((e) => e.defId === 'bandage'), '乙的绷带用掉');
  assert.equal(sb.handoffs.filter((x) => x.kind === 'heal').length, 0, '直接送到的不再生成交接文本');

  // 行动：甲、乙先在自己的页面选好，轮到时主持人页自动记录
  await tab(host, 'flow');
  await host.locator('.top-actions .btn.primary').click(); // 交流
  await host.locator('.top-actions .btn.primary').click(); // 轮换
  await btn(host, '执行每日轮换').click();
  await tab(a, 'action');
  await a.locator('[data-action="other"]').click();
  await tab(b, 'action');
  await b.locator('[data-action="plan"]').click();
  await host.locator('.top-actions .btn.primary').click(); // 个人行动
  hs = await until(host, HOST_DEMO, (s) => s.today.netPending && s.today.netPending[P(1)] && s.today.netPending[P(2)], '两人的选择到了主持人页');
  assert.deepEqual(hs.today.actionOrder.slice(0, 3), [P(6), P(1), P(2)]);
  await host.locator('tr[data-player="' + P(1) + '"] .chip.info').waitFor();
  // F 不在房间里：主持人照常记录；之后轮到甲、乙，自动记下
  await host.locator(`tr[data-player="${P(6)}"]`).getByRole('button', { name: '记录行动' }).click();
  await modal(host).getByRole('button', { name: '放弃行动' }).click();
  await modalBtn(host, '记录');
  hs = await until(host, HOST_DEMO, (s) => s.today.actedIds.includes(P(1)) && s.today.actedIds.includes(P(2)), '甲乙自动记录');
  assert.equal(hs.today.actions.find((x) => x.playerId === P(1)).type, 'other');
  assert.ok(hs.today.plannerIds.includes(P(2)));
  assert.ok(hs.today.actions.filter((x) => x.via === 'net').length >= 2);

  // 乙：抽守夜卡、选一张、直接交给主持人 → 主持人页候选里出现（来源：玩家页）
  await b.getByRole('button', { name: '确认抽取守夜名单' }).click();
  await b.locator('.wcards button').first().click();
  await b.getByRole('button', { name: '直接交给主持人' }).click();
  hs = await until(host, HOST_DEMO, (s) => s.today.watchCandidates.some((c) => c.plannerId === P(2) && c.source === 'net'), '守夜卡到了主持人页');

  // 主持人私信乙；乙离线时发的私信上线后补收
  await tab(host, 'net');
  await reveal(host, 'netmsg');
  await host.locator('.net-page select').first().selectOption(P(2));
  await host.locator('.net-page textarea').last().fill('乙：今晚你守夜');
  await host.getByRole('button', { name: '发送', exact: true }).click();
  sb = await until(b, PLAYER_KEY, (s) => s.inbox.some((x) => x.kind === 'text' && x.text === '乙：今晚你守夜'), '乙收到私信');
  await b.close();
  await host.locator('tr[data-net-player="' + P(2) + '"]', { hasText: '已加入 · 离线' }).waitFor();
  await host.locator('.net-page select').first().selectOption(P(2));
  await host.locator('.net-page textarea').last().fill('乙：离线时的消息');
  await host.getByRole('button', { name: '发送', exact: true }).click();
  const { page: b2, errors: b2Errors } = await open(ctxB, base + '/player.html');
  await until(b2, PLAYER_KEY, (s) => s.inbox.some((x) => x.text === '乙：离线时的消息'), '上线后补收');
  assert.ok(await b2.locator('.net-chip .net-unread').isVisible(), '顶栏显示未读');

  // 主持人撤销自己的上一步操作，不会把玩家页来的修改一起撤掉
  hs = await read(host, HOST_DEMO);
  const acted = hs.today.actedIds.slice();
  const candidates = hs.today.watchCandidates.length;
  await host.getByRole('button', { name: '撤销', exact: true }).first().click(); // 撤销：记录 F 的行动
  hs = await read(host, HOST_DEMO);
  assert.ok(!hs.today.actedIds.includes(P(6)), 'F 的记录撤掉了');
  assert.equal(hs.today.watchCandidates.length, candidates, '玩家页交来的守夜卡还在');
  assert.ok(hs.batches.at(-1).picks.length === 2 && hs.pool.reduce((n, e) => n + e.qty, 0) >= poolBefore + 1, '领取、交公都还在');
  assert.ok(acted.includes(P(1)));
  assert.ok(hs.today.netPending[P(1)], '甲还没轮到：玩家页的选择还在，轮到时再自动记录');
  await tab(host, 'flow');
  await host.locator(`tr[data-player="${P(6)}"]`).getByRole('button', { name: '记录行动' }).click();
  await modal(host).getByRole('button', { name: '放弃行动' }).click();
  await modalBtn(host, '记录');
  await until(host, HOST_DEMO, (s) => s.today.actedIds.includes(P(6)) && s.today.actedIds.includes(P(1)), '重新记录 F 后甲自动记录');

  // 乙换手机：新设备选同一个名字，主持人通过 → 旧设备断开，新设备收到规则包
  await tab(host, 'net');
  const ctxB3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page: b3, errors: b3Errors } = await open(ctxB3, link.replace(/^https?:\/\/[^/]+/, base));
  await b3.locator('.net-roster button', { hasText: 'B·阿珍' }).click();
  await host.locator('.net-guest').getByRole('button', { name: '通过请求' }).click();
  await until(b3, PLAYER_KEY, (s) => s.name === 'B·阿珍' && s.inbox.some((x) => /规则包/.test(x.text)), '新设备收到规则包');
  await b2.locator('.net-chip.st-elsewhere').waitFor();

  // 主持人重置存档：不会把玩家手上的东西自动扣回
  const aBefore = await read(a, PLAYER_KEY);
  await tab(host, 'settings');
  await btn(host, '重置存档').click();
  await modalBtn(host, '重置');
  await tab(host, 'settings');
  await host.locator('input[placeholder="玩家名字"]').fill('临时玩家');
  await btn(host, '新增玩家').click();
  await a.waitForTimeout(800);
  const aAfter = await read(a, PLAYER_KEY);
  assert.deepEqual(aAfter.inventory, aBefore.inventory, '重置后玩家库存不变');
  assert.equal(aAfter.inbox.filter((x) => x.kind === 'revoke').length, aBefore.inbox.filter((x) => x.kind === 'revoke').length, '没有自动撤回');

  assert.deepEqual(hostErrors, [], 'host errors');
  assert.deepEqual(aErrors, [], 'player A errors');
  assert.deepEqual(bErrors.filter((e) => !/WebSocket/.test(e)), [], 'player B errors');
  assert.deepEqual(b2Errors, [], 'player B (reopened) errors');
  assert.deepEqual(b3Errors, [], 'player B (new device) errors');
  await Promise.all([hostCtx.close(), ctxA.close(), ctxB.close(), ctxB3.close()]);
});

const HAN = /[一-鿿]/;
async function leftoverChinese(page) {
  return page.evaluate((src) => {
    const han = new RegExp(src);
    const parts = [document.body.innerText, document.title];
    document.querySelectorAll('[placeholder],[title],[aria-label]').forEach((e) => {
      if (e.classList.contains('lang-btn')) return;
      parts.push(e.getAttribute('placeholder') || '', e.getAttribute('title') || '', e.getAttribute('aria-label') || '');
    });
    document.querySelectorAll('textarea, input[type=text]').forEach((t) => parts.push(t.value));
    return parts.join('\n').split('\n').filter((l) => han.test(l) && l.trim() !== '中文');
  }, HAN.source);
}

test('联机界面英文：主持人联机页、等待通过、公开展示二维码、玩家加入、现场、投票、收件箱都没有残留中文', async () => {
  const en = () => localStorage.setItem('shelter-playtest:lang', 'en');
  const hostCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await hostCtx.addInitScript(en);
  const { page: host, errors } = await open(hostCtx, base + '/host.html');
  await tab(host, 'settings');
  await btn(host, 'Open demo save').click();
  await host.waitForFunction((k) => !!localStorage.getItem(k), HOST_DEMO);
  await tab(host, 'net');
  assert.deepEqual(await leftoverChinese(host), [], 'host net (no room)');
  await host.locator('.net-room .btn.primary').click();
  await host.locator('.net-code').waitFor();
  const link = await host.locator('.net-room textarea.copy-text').inputValue();
  await host.locator('.net-room input[type=checkbox]').first().uncheck(); // 关掉自动通过：看等待通过的样子
  assert.deepEqual(await leftoverChinese(host), [], 'host net (room open)');

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(en);
  const { page: p, errors: pErrors } = await open(ctx, link.replace(/^https?:\/\/[^/]+/, base));
  await p.locator('.net-roster button').first().waitFor();
  assert.deepEqual(await leftoverChinese(p), [], 'player lobby');
  await p.locator('.net-roster button').first().click();
  await p.locator('.net-wait').waitFor();
  assert.deepEqual(await leftoverChinese(p), [], 'player waiting');
  await host.locator('.net-guest').waitFor();
  assert.deepEqual(await leftoverChinese(host), [], 'host guest waiting');
  await host.locator('.net-guest .btn.primary').click();
  await p.locator('.pn-live').first().waitFor();
  await until(p, PLAYER_KEY, (s) => (s.inbox || []).length > 0, 'rules pack');
  assert.deepEqual(await leftoverChinese(p), [], 'player net (joined)');

  // 第 1 天、补给候选、事件投票
  await tab(host, 'flow');
  await btn(host, 'Start Day 1 →').click();
  await modalBtn(host, 'Start');
  await host.locator('.top-actions .btn.primary').click();
  await tab(host, 'supply');
  await reveal(host, 'pool', 'Show');
  await btn(host, 'Draw').click();
  await btn(host, 'Hide all secrets').click();
  await tab(host, 'events');
  await reveal(host, 'events', 'Show');
  const hs = await read(host, HOST_DEMO);
  const ev = hs.events.find((e) => e.options.some((o) => o.outcomes.some((x) => x.effects.personal && x.effects.personal.hp === -1)));
  await host.locator('select', { has: host.locator('option', { hasText: 'Choose an event by hand…' }) }).selectOption(ev.id);
  await btn(host, 'Use chosen event').click();
  await host.locator('.flow-steps').getByRole('button', { name: 'Publish to public page' }).click();
  await host.locator('.flow-steps .btn', { hasText: /player pages/i }).first().click();
  await tab(p, 'dashboard');
  await p.locator('.pn-offer').waitFor();
  await p.locator('[data-vote]').first().click();
  await until(host, HOST_DEMO, (s) => s.today.eventFlow.netVote && Object.keys(s.today.eventFlow.netVote.ballots).length === 1, 'ballot');
  assert.deepEqual(await leftoverChinese(p), [], 'player dashboard (offer + vote)');
  assert.deepEqual(await leftoverChinese(host), [], 'host events (player-page vote)');
  // 领一件，结果发到玩家页
  await p.locator('.pn-offer [data-piece]').first().click();
  await modal(p).locator('.btn.primary').click();
  await until(p, PLAYER_KEY, (s) => s.inbox.some((x) => x.kind === 'grant'), 'grant');
  await host.locator('.net-vote .btn.primary').click(); // 结束投票并采用结果
  const flow = (await read(host, HOST_DEMO)).today.eventFlow;
  const opt = flow.event.options.find((o) => o.id === flow.vote);
  const outcome = opt.outcomes.find((x) => x.effects.personal && x.effects.personal.hp === -1) || opt.outcomes[0];
  await host.locator('select', { has: host.locator('option', { hasText: 'Choose a result by hand…' }) }).selectOption(outcome.id);
  await btn(host, 'Set by hand').click();
  await btn(host, 'Confirm resolution').click();
  await btn(host, 'Send to player pages (personal effects apply in one tap)').click();
  await modal(host).locator('label.check input').first().check();
  assert.deepEqual(await leftoverChinese(host), [], 'host effect dialog');
  await modalBtn(host, 'Send');
  await until(p, PLAYER_KEY, (s) => s.inbox.some((x) => x.kind === 'effect'), 'effect');
  await tab(p, 'net');
  assert.deepEqual(await leftoverChinese(p), [], 'player inbox (grant, effect, rules)');
  await btn(host, 'Hide all secrets').click();
  await tab(host, 'net');
  await host.locator('.net-room input[type=checkbox]').nth(1).check(); // 公开展示页显示二维码
  await tab(host, 'stage');
  await host.locator('.net-stage-join').waitFor();
  assert.deepEqual(await leftoverChinese(host), [], 'host stage with QR');
  assert.deepEqual(errors, []);
  assert.deepEqual(pErrors, []);
  await Promise.all([hostCtx.close(), ctx.close()]);
});
