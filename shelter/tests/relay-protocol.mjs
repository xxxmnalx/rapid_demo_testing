// 联机房间的协议测试：同一套用例分别跑在局域网服务器（room.test.mjs）和 Cloudflare 本地运行时（relay-worker.test.mjs）上。
import assert from 'node:assert/strict';

/** 一个测试用的 WebSocket 客户端：收到的消息排队，next(条件) 等待下一条符合条件的消息。 */
export function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const inbox = [];
  const waiters = [];
  let closed = null;
  ws.addEventListener('message', (ev) => {
    const data = ev.data === 'pong' ? 'pong' : JSON.parse(ev.data);
    const i = waiters.findIndex((w) => w.pred(data));
    if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(data); } else inbox.push(data);
  });
  ws.addEventListener('close', (ev) => { closed = ev.code; waiters.splice(0).forEach((w) => { clearTimeout(w.timer); w.reject(new Error('closed ' + ev.code + ' while waiting for ' + w.label)); }); });
  const api = {
    ws,
    opened: new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); }),
    send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
    next(pred, label = 'message', timeout = 5000) {
      if (typeof pred === 'string') { const t = pred; label = t; pred = (d) => d && d.t === t; }
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      if (closed != null) return Promise.reject(new Error('already closed ' + closed + ' while waiting for ' + label));
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, reject, label, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timeout waiting for ' + label + '; inbox=' + JSON.stringify(inbox).slice(0, 400))); }, timeout) };
        waiters.push(w);
      });
    },
    drain: () => inbox.splice(0),
    closedCode: () => closed,
    closedPromise: new Promise((res) => ws.addEventListener('close', (ev) => res(ev.code))),
    close: () => ws.close()
  };
  return api;
}

const SNAP = { v: 1, day: 2, phase: 'actions', players: [{ id: 'p1', name: '甲', alive: true }, { id: 'p2', name: '乙', alive: true }, { id: 'p3', name: '丙', alive: false }] };

export async function runProtocol(base, { label = '' } = {}) {
  const wsBase = base.replace(/^http/, 'ws');
  const r = await fetch(base + '/api/rooms', { method: 'POST' });
  assert.equal(r.status, 200, label + ' 新建房间');
  assert.equal(r.headers.get('access-control-allow-origin'), '*', '允许任意来源的页面创建房间');
  const { code, hostKey } = await r.json();
  assert.match(code, /^[2-9A-HJKMNP-Z]{5}$/);
  assert.equal(hostKey.length, 24);
  const url = wsBase + '/ws/' + code;

  // 主持人登录
  const host = client(url);
  await host.opened;
  host.send({ t: 'hello', v: 1, role: 'host', key: hostKey });
  const hw = await host.next('welcome');
  assert.equal(hw.role, 'host');
  assert.equal(hw.code, code);
  host.send('ping');
  assert.equal(await host.next((d) => d === 'pong', 'pong'), 'pong');
  host.send({ t: 'pub', s: SNAP });

  // 密钥不对
  const bad = client(url);
  await bad.opened;
  bad.send({ t: 'hello', v: 1, role: 'host', key: 'wrong-key-wrong-key-xxxx' });
  assert.equal((await bad.next('err')).code, 'bad-key');
  assert.ok((await bad.closedPromise) >= 4000);

  // 玩家甲加入：先看到名单（只有名字），提出请求，主持人通过
  const a = client(url);
  await a.opened;
  a.send({ t: 'hello', v: 1, role: 'guest' });
  const lobby = await a.next('lobby');
  assert.deepEqual(lobby.roster.map((p) => p.name), ['甲', '乙', '丙']);
  assert.equal(lobby.roster.every((p) => p.joined === false), true);
  assert.equal(lobby.snap, undefined, '还没通过的人看不到公开信息以外的任何东西');
  a.send({ t: 'request', pid: 'p1', name: '甲' });
  await a.next('requested');
  const join = await host.next('join');
  assert.deepEqual([join.pid, join.name], ['p1', '甲']);
  host.send({ t: 'approve', gid: join.gid, pid: 'p1' });
  const approved = await a.next('approved');
  assert.equal(approved.pid, 'p1');
  const aw = await a.next('welcome');
  assert.deepEqual(aw.you, { pid: 'p1', name: '甲' });
  assert.equal(aw.snap.day, 2, '通过后收到主持人最近一次公开的信息');
  const bound = await host.next('bound');
  assert.deepEqual(bound.players.map((p) => p.pid), ['p1']);
  const tokenA = approved.token;

  // 玩家乙加入
  const b = client(url);
  await b.opened;
  b.send({ t: 'hello', v: 1, role: 'guest' });
  await b.next('lobby');
  b.send({ t: 'request', pid: 'p2' });
  const join2 = await host.next('join');
  host.send({ t: 'approve', gid: join2.gid, pid: 'p2' });
  const approvedB = await b.next('approved');
  await b.next('welcome');
  const tokenB = approvedB.token;

  // 主持人公开信息：所有玩家实时收到
  host.send({ t: 'pub', s: Object.assign({}, SNAP, { day: 3 }) });
  assert.equal((await a.next('snap')).s.day, 3);
  assert.equal((await b.next('snap')).s.day, 3);

  // 主持人私信甲：只有甲收到；同一条重发只收一次
  const dm = { id: 'dm-1', kind: 'text', text: '只给甲看' };
  host.send({ t: 'send', to: 'p1', m: dm });
  host.send({ t: 'send', to: 'p1', m: dm });
  assert.equal((await host.next('ok')).id, 'dm-1');
  assert.equal((await host.next('ok')).id, 'dm-1', '重发也回 ok，发送方可以清掉待发队列');
  const got = await a.next('msg');
  assert.equal(got.e.m.text, '只给甲看');
  assert.equal(got.e.from, 'host');
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(a.drain().filter((d) => d.t === 'msg').length, 0, '重发的同一条消息没有再送一次');
  assert.equal(b.drain().filter((d) => d.t === 'msg').length, 0, '乙看不到给甲的私信');

  // 甲没有回 ack：重连后再送一次；回了 ack 之后就删掉
  a.close();
  await a.closedPromise;
  const a2 = client(url);
  await a2.opened;
  a2.send({ t: 'hello', v: 1, role: 'player', token: tokenA });
  await a2.next('welcome');
  const again = await a2.next('msgs');
  assert.deepEqual(again.list.map((e) => e.m.id), ['dm-1']);
  a2.send({ t: 'ack', ids: again.list.map((e) => e.id) });

  // 玩家 → 主持人
  a2.send({ t: 'up', m: { id: 'up-1', kind: 'vote', optionId: 'A' } });
  assert.equal((await a2.next('ok')).id, 'up-1');
  const up = await host.next('msg');
  assert.deepEqual([up.e.from, up.e.fromName, up.e.m.kind], ['p1', '甲', 'vote']);
  host.send({ t: 'ack', ids: [up.e.id] });

  // 玩家 → 玩家（赠予）：对方收到，主持人收到副本
  a2.send({ t: 'p2p', to: 'p2', m: { id: 'gift-1', kind: 'gift', items: [{ defId: 'bread', qty: 1 }] } });
  assert.equal((await a2.next('ok')).id, 'gift-1');
  const gift = await b.next('msg');
  assert.equal(gift.e.m.kind, 'gift');
  assert.equal(gift.e.from, 'p1');
  const cc = await host.next('msg');
  assert.equal(cc.e.cc, 'p2', '主持人留一份副本');
  b.send({ t: 'ack', ids: [gift.e.id] });
  host.send({ t: 'ack', ids: [cc.e.id] });
  a2.send({ t: 'p2p', to: 'nobody', m: { id: 'gift-2', kind: 'gift' } });
  const noSuch = await a2.next('err');
  assert.equal(noSuch.code, 'no-such-player');
  assert.equal(noSuch.id, 'gift-2', '出错的消息带着 id：发送方据此不再重发');

  // 乙离线时主持人发的消息，乙上线后收到
  b.close();
  await b.closedPromise;
  const pres = await host.next((d) => d.t === 'presence' && !d.online.includes('p2') && d.online.includes('p1'), 'presence: p1 online, p2 offline');
  assert.deepEqual(pres.online, ['p1']);
  host.send({ t: 'send', to: '*', m: { id: 'all-1', kind: 'text', text: '大家好' } });
  await host.next('ok');
  assert.equal((await a2.next('msg')).e.m.id, 'all-1');
  const b2 = client(url);
  await b2.opened;
  b2.send({ t: 'hello', v: 1, role: 'player', token: tokenB });
  await b2.next('welcome');
  assert.deepEqual((await b2.next('msgs')).list.map((e) => e.m.id), ['all-1'], '离线期间的消息上线后补收');

  // 同一个玩家在另一台设备上登录：旧连接被替换
  const b3 = client(url);
  await b3.opened;
  b3.send({ t: 'hello', v: 1, role: 'player', token: tokenB });
  await b3.next('welcome');
  await b2.next('replaced');

  // 凭证不对
  const fake = client(url);
  await fake.opened;
  fake.send({ t: 'hello', v: 1, role: 'player', token: 'not-a-real-token-123' });
  assert.equal((await fake.next('err')).code, 'bad-token');

  // 版本不对
  const old = client(url);
  await old.opened;
  old.send({ t: 'hello', v: 99, role: 'guest' });
  assert.equal((await old.next('err')).code, 'version');

  // 主持人移出乙：乙被断开，旧凭证失效
  host.send({ t: 'kick', pid: 'p2' });
  await b3.next('kicked');
  const b4 = client(url);
  await b4.opened;
  b4.send({ t: 'hello', v: 1, role: 'player', token: tokenB });
  assert.equal((await b4.next('err')).code, 'bad-token');

  // 第二个主持人连接顶替第一个（避免两个标签页重复处理）
  const host2 = client(url);
  await host2.opened;
  host2.send({ t: 'hello', v: 1, role: 'host', key: hostKey });
  await host2.next('welcome');
  await host.next('replaced');

  // 结束房间：所有人收到 ended；之后连不上
  host2.send({ t: 'end' });
  await a2.next('ended');
  await host2.next('ended');
  await new Promise((res) => setTimeout(res, 200));
  const late = client(url);
  await late.opened;
  late.send({ t: 'hello', v: 1, role: 'guest' });
  assert.equal((await late.next('err')).code, 'no-room', '结束的房间连不上');

  // 不存在的房间
  const none = client(wsBase + '/ws/ZZZZZ');
  await none.opened;
  assert.equal((await none.next('err')).code, 'no-room');
  [host, bad, a, a2, b, b2, b3, b4, fake, old, host2, late, none].forEach((c) => { try { c.close(); } catch (e) { /* 忽略 */ } });
}

/** 大消息：接近上限的公开信息（含中文）和大私信，玩家重连后照样收到。 */
export async function runLarge(base) {
  const wsBase = base.replace(/^http/, 'ws');
  const { code, hostKey } = await (await fetch(base + '/api/rooms', { method: 'POST' })).json();
  const url = wsBase + '/ws/' + code;
  const host = client(url);
  await host.opened;
  host.send({ t: 'hello', v: 1, role: 'host', key: hostKey });
  await host.next('welcome');
  const feed = '避难所公开结果'.repeat(40000); // 28 万字（UTF-8 约 840KB）
  host.send({ t: 'pub', s: { players: [{ id: 'p1', name: '甲' }], feed } });
  const g = client(url);
  await g.opened;
  g.send({ t: 'hello', v: 1, role: 'guest' });
  await g.next('lobby');
  g.send({ t: 'request', pid: 'p1' });
  const join = await host.next('join');
  host.send({ t: 'approve', gid: join.gid, pid: 'p1' });
  const { token } = await g.next('approved');
  assert.equal((await g.next('welcome')).snap.feed.length, feed.length, '大公开信息收发正常');
  g.close();
  await g.closedPromise;
  const text = '私信'.repeat(75000);
  host.send({ t: 'send', to: 'p1', m: { id: 'big-dm', kind: 'text', text } });
  assert.equal((await host.next('ok')).id, 'big-dm');
  host.send({ t: 'send', to: 'p1', m: { id: 'big-dm-2', kind: 'text', text } });
  assert.equal((await host.next('ok')).id, 'big-dm-2');
  await new Promise((res) => setTimeout(res, 300));
  const g2 = client(url);
  await g2.opened;
  g2.send({ t: 'hello', v: 1, role: 'player', token });
  assert.equal((await g2.next('welcome')).snap.feed.length, feed.length, '重连后公开信息还在');
  // 积压的消息分帧补发：两条各 15 万字，分两帧
  const first = await g2.next('msgs');
  const second = await g2.next('msgs');
  assert.deepEqual(first.list.concat(second.list).map((e) => e.m.id), ['big-dm', 'big-dm-2'], '离线时的大私信上线后分帧收到');
  assert.equal(first.list[0].m.text.length, text.length);
  host.send({ t: 'end' });
  await host.next('ended');
  [host, g, g2].forEach((c) => { try { c.close(); } catch (e) { /* 忽略 */ } });
}
