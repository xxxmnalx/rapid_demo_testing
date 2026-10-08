// 联机房间：纯逻辑单元测试 + 局域网服务器上的完整协议测试。
// 运行：node --test tests/room.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Room, newRoom, makeCode, isCode, LIMITS } from '../relay/src/room.js';
import { startServer } from '../lan/server.mjs';
import { runProtocol, runLarge, client } from './relay-protocol.mjs';

/** 假的适配层：连接就是普通对象，发出的消息记在 out 里。 */
function fakeIo() {
  const conns = [];
  const saved = [];
  let t = 1000;
  const io = {
    conns: () => conns.filter((c) => c.open),
    meta: (c) => c.meta,
    setMeta: (c, m) => { c.meta = m; },
    send: (c, obj) => { c.out.push(typeof obj === 'string' ? obj : JSON.parse(JSON.stringify(obj))); },
    close: (c) => { c.open = false; },
    now: () => (t += 10),
    rand: Math.random,
    save: (k) => saved.push(k)
  };
  return { io, conns, saved, conn() { const c = { open: true, meta: null, out: [] }; conns.push(c); return c; } };
}

const last = (c, t) => c.out.filter((d) => d.t === t).pop();
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); });
    srv.on('error', rej);
  });
}

test('房间码与密钥：只用不易混淆的字符', () => {
  for (let i = 0; i < 200; i++) assert.ok(isCode(makeCode(Math.random, 5)));
  assert.equal(isCode('ABCD0'), false, '没有 0');
  assert.equal(isCode('abcde'), false);
  assert.equal(isCode('AB'), false);
});

test('房间逻辑：登录、通过、转发、暂存与 ack、限流', () => {
  const f = fakeIo();
  const room = new Room(newRoom('ABCDE', 'k'.repeat(24), 0), null, f.io);
  const host = f.conn();
  room.message(host, JSON.stringify({ t: 'pub', s: {} }));
  assert.equal(last(host, 'err').code, 'hello-first', '没登录先发消息会被拒绝');
  const host2 = f.conn();
  room.message(host2, JSON.stringify({ t: 'hello', v: 1, role: 'host', key: 'k'.repeat(24) }));
  assert.equal(last(host2, 'welcome').role, 'host');
  room.message(host2, JSON.stringify({ t: 'pub', s: { players: [{ id: 'p1', name: '甲' }] } }));
  assert.ok(f.saved.includes('snap'));

  const g = f.conn();
  room.message(g, JSON.stringify({ t: 'hello', v: 1, role: 'guest' }));
  assert.deepEqual(last(g, 'lobby').roster, [{ id: 'p1', name: '甲', alive: true, joined: false }]);
  room.message(g, JSON.stringify({ t: 'request', pid: 'p1', name: '甲' }));
  const join = last(host2, 'join');
  room.message(host2, JSON.stringify({ t: 'approve', gid: join.gid, pid: 'p1' }));
  assert.equal(g.meta.role, 'player');
  assert.equal(room.room.players.p1.name, '甲');

  // 玩家 → 主持人：主持人在线时立刻送达，ack 后删除
  room.message(g, JSON.stringify({ t: 'up', m: { id: 'x1', kind: 'vote' } }));
  const m = last(host2, 'msg');
  assert.equal(m.e.from, 'p1');
  assert.equal(room.room.queues.host.length, 1);
  room.message(host2, JSON.stringify({ t: 'ack', ids: [m.e.id] }));
  assert.equal(room.room.queues.host.length, 0);

  // 队列有上限：最旧的先丢
  for (let i = 0; i < LIMITS.queue + 5; i++) room.message(host2, JSON.stringify({ t: 'send', to: 'p9', m: { id: 'q' + i } }));
  assert.equal(room.room.queues.p9.length, LIMITS.queue);
  assert.equal(room.room.queues.p9[0].m.id, 'q5');

  // 每分钟消息数有上限
  const spam = f.conn();
  room.message(spam, JSON.stringify({ t: 'hello', v: 1, role: 'guest' }));
  for (let i = 0; i < LIMITS.perMinute + 3; i++) room.message(spam, JSON.stringify({ t: 'request', name: 'x' }));
  assert.equal(last(spam, 'err').code, 'rate');

  // 断开时在线名单不再算它
  const pres = host2.out.length;
  g.open = false;
  room.closed(g);
  assert.deepEqual(host2.out.slice(pres).filter((d) => d.t === 'presence').pop().online, []);
});

// ---------------------------------------------------------------- 局域网服务器

const dir = mkdtempSync(join(tmpdir(), 'shelter-lan-'));
const dataFile = join(dir, 'data.json');
let server;
let base;

async function boot() {
  server = startServer({ port: 0, host: '127.0.0.1', data: dataFile, quiet: true });
  await new Promise((res) => server.on('listening', res));
  base = 'http://127.0.0.1:' + server.address().port;
}

after(() => server && server.close());

test('房间逻辑：暂存消息总量有上限，超出时从积压最多的收件人那里丢最早的', () => {
  const f = fakeIo();
  const room = newRoom('ABCDE', 'k'.repeat(24), 0);
  room.players = { p1: { name: '甲', token: 't'.repeat(24), boundAt: 0 }, p2: { name: '乙', token: 'u'.repeat(24), boundAt: 0 } };
  const core = new Room(room, { players: [{ id: 'p1', name: '甲' }, { id: 'p2', name: '乙' }] }, f.io);
  const host = f.conn();
  core.message(host, JSON.stringify({ t: 'hello', v: 1, role: 'host', key: 'k'.repeat(24) }));
  const chunk = 'x'.repeat(40000);
  for (let i = 0; i < 20; i++) core.message(host, JSON.stringify({ t: 'send', to: 'p1', m: { id: 'a' + i, kind: 'text', text: chunk } }));
  core.message(host, JSON.stringify({ t: 'send', to: 'p2', m: { id: 'b0', kind: 'text', text: 'hello' } }));
  const total = Object.values(room.queues).flat().reduce((n, e) => n + JSON.stringify(e.m).length, 0);
  assert.ok(total <= LIMITS.storeChars, '总量不超过上限：' + total);
  assert.equal(room.queues.p1.at(-1).m.id, 'a19', '最新的保留');
  assert.ok(room.queues.p1[0].m.id !== 'a0', '最早的被丢掉');
  assert.deepEqual(room.queues.p2.map((e) => e.m.id), ['b0'], '别人的消息不受影响');
});

test('局域网服务器：提供三个页面并注明是局域网模式；健康检查', async () => {
  await boot();
  for (const p of ['/', '/host.html', '/player.html']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(html, /window\.SHELTER_LAN = \{"v":1,"urls":\[/, p + ' 注入了局域网标记');
  }
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.deepEqual(await (await fetch(base + '/health')).json(), { ok: true, service: 'shelter-lan', v: 1, rooms: 0 });
});

test('局域网服务器：完整协议（加入、通过、公开信息、私信、离线补收、赠予、移出、结束）', async () => {
  await runProtocol(base, { label: 'LAN' });
  await runLarge(base);
});

test('局域网服务器：大消息（超过 64KB 的公开信息）和重启后房间还在', async () => {
  const { code, hostKey } = await (await fetch(base + '/api/rooms', { method: 'POST' })).json();
  const url = base.replace('http', 'ws') + '/ws/' + code;
  const host = client(url);
  await host.opened;
  host.send({ t: 'hello', v: 1, role: 'host', key: hostKey });
  await host.next('welcome');
  const big = { players: [{ id: 'p1', name: '甲' }], feed: 'x'.repeat(120000) };
  host.send({ t: 'pub', s: big });
  const g = client(url);
  await g.opened;
  g.send({ t: 'hello', v: 1, role: 'guest' });
  g.send({ t: 'request', pid: 'p1' });
  const join = await host.next('join');
  host.send({ t: 'approve', gid: join.gid, pid: 'p1' });
  const { token } = await g.next('approved');
  const w = await g.next('welcome');
  assert.equal(w.snap.feed.length, 120000, '大于 64KB 的帧收发正常');
  host.close();
  g.close();
  await new Promise((res) => setTimeout(res, 700));
  // 重启服务器：房间、凭证都还在
  await new Promise((res) => server.close(res));
  assert.ok(existsSync(dataFile));
  assert.ok(readFileSync(dataFile, 'utf8').includes(code));
  await boot();
  const url2 = base.replace('http', 'ws') + '/ws/' + code;
  const again = client(url2);
  await again.opened;
  again.send({ t: 'hello', v: 1, role: 'player', token });
  const w2 = await again.next('welcome');
  assert.equal(w2.you.pid, 'p1');
  assert.equal(w2.snap.feed.length, 120000);
  again.close();
});

test('单文件局域网服务器（构建产物 shelter-lan.mjs）：单独拷到别的目录也能运行，页面与协议齐全', async (t) => {
  const bundle = join(ROOT_DIR, 'shelter-lan.mjs');
  if (!existsSync(bundle)) { t.skip('还没构建 shelter-lan.mjs（node build.mjs）'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'shelter-lan-bundle-'));
  copyFileSync(bundle, join(dir, 'shelter-lan.mjs'));
  const port = await freePort();
  const child = spawn(process.execPath, [join(dir, 'shelter-lan.mjs'), '--port', String(port)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  try {
    const base = 'http://127.0.0.1:' + port;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/health')).ok) break; } catch (e) { /* 还没起来 */ }
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.match(output, /局域网联机服务器已启动/, '启动时告诉主持人地址');
    for (const page of ['/', '/host.html', '/player.html']) {
      const html = await (await fetch(base + page)).text();
      assert.match(html, /window\.SHELTER_LAN = /, page + ' 注明局域网模式');
    }
    assert.equal((await fetch(base + '/host.html')).headers.get('content-type'), 'text/html; charset=utf-8');
    await runProtocol(base, { label: 'bundle' });
  } finally {
    child.kill('SIGTERM');
    await new Promise((res) => child.once('exit', res));
  }
  assert.ok(existsSync(join(dir, 'shelter-lan-data.json')), '停止时把房间数据存在当前目录');
});
