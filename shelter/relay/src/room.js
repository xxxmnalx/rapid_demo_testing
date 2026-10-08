/*
 * 避难所 Playtest · 联机房间（纯逻辑）
 *
 * 云端（Cloudflare Durable Object，relay/src/worker.js）和局域网（Node，lan/server.mjs）共用这一份。
 * 房间只负责认人、转发和暂存消息，不懂游戏规则：主持人页仍是唯一的「裁判」，所有改动都在主持人页里发生。
 *
 * 角色：
 *   host   凭 hostKey 连接（创建房间时拿到），同一时间只保留一个主持人连接；
 *   player 凭 token 连接（主持人通过加入请求时发给玩家）；
 *   guest  还没被主持人通过的加入请求，只能看到名单、提出请求。
 *
 * 消息都是 JSON 文本。收件人不在线时先暂存在房间里，收件人处理完回 ack 才删掉；
 * 发送方每条消息带自己的 id，房间回 ok 后发送方才从待发队列里删掉，重连后重发的同一条消息会被忽略。
 *
 * 适配层（io）需要提供：conns()、meta(conn)、setMeta(conn, meta)、send(conn, obj)、close(conn, code, reason)、
 * now()、rand()、save(kind)（kind：'room' | 'snap' | 'delete'，由适配层决定何时真正写入）。
 */

export const PROTOCOL = 1;

export const LIMITS = {
  players: 32,
  guests: 32,
  queue: 300,
  // 房间里暂存的消息加起来的上限（字符数）：云端把整个房间存成一条记录，单条记录有大小上限
  storeChars: 500000,
  // 单条消息、公开信息的上限：按中文每字 3 字节算也在云端 1 MiB 的 WebSocket 消息上限以内
  textChars: 200000,
  snapChars: 300000,
  // 补发积压消息时每帧最多这么多字符，分几帧发
  batchChars: 200000,
  seen: 300,
  perMinute: 240
};

const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const SECRET_CHARS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp('^[' + CODE_CHARS + ']{4,8}$');

export function makeCode(rand, len) {
  var s = '';
  for (var i = 0; i < (len || 5); i++) s += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length) % CODE_CHARS.length];
  return s;
}

export function isCode(s) {
  return typeof s === 'string' && CODE_RE.test(s);
}

export function makeSecret(rand, len) {
  var s = '';
  for (var i = 0; i < (len || 24); i++) s += SECRET_CHARS[Math.floor(rand() * SECRET_CHARS.length) % SECRET_CHARS.length];
  return s;
}

export function newRoom(code, hostKey, now) {
  return {
    v: PROTOCOL, code: code, hostKey: hostKey, createdAt: now, lastActive: now, seq: 0,
    players: {},  // pid → { name, token, boundAt }
    queues: {},   // 'host' 或 pid → [{ id, from, fromName, m, at, cc }]
    seen: {}      // 发送方（'host' 或 pid）→ 最近处理过的消息 id
  };
}

function isId(x) {
  return typeof x === 'string' && x.length > 0 && x.length <= 80;
}

export class Room {
  /**
   * room：newRoom() 的结构（从存储里读出来的也行）；snap：主持人最近一次发布的公开信息（可为 null）。
   */
  constructor(room, snap, io) {
    this.room = room;
    this.snap = snap || null;
    this.io = io;
    this.rate = new Map();
  }

  // ---------------------------------------------------------------- 连接查询

  conns(filter) {
    var io = this.io;
    var gone = this.gone;
    return io.conns().filter(function (c) {
      if (c === gone) return false;
      var m = io.meta(c);
      return m && m.role && (!filter || filter(m));
    });
  }

  hostConns() { return this.conns(function (m) { return m.role === 'host'; }); }
  playerConns(pid) { return this.conns(function (m) { return m.role === 'player' && (!pid || m.pid === pid); }); }
  guestConns() { return this.conns(function (m) { return m.role === 'guest'; }); }

  onlinePlayers() {
    var out = [];
    var io = this.io;
    this.playerConns().forEach(function (c) { var pid = io.meta(c).pid; if (out.indexOf(pid) < 0) out.push(pid); });
    return out;
  }

  send(conn, obj) {
    try { this.io.send(conn, obj); } catch (e) { /* 连接已经断开：等它重连后补发 */ }
  }

  /** extra.id：出错的是哪一条消息（发送方据此把它从待发队列里拿掉，不再重发）。 */
  fail(conn, code, message, close, extra) {
    this.send(conn, Object.assign({ t: 'err', code: code, message: message || code }, extra || {}));
    if (close) this.io.close(conn, 4000, code);
  }

  touch() {
    var now = this.io.now();
    // 活跃时间每分钟最多记一次，避免每条消息都写存储
    if (now - this.room.lastActive > 60000) { this.room.lastActive = now; this.io.save('room'); }
  }

  // ---------------------------------------------------------------- 入口

  message(conn, text) {
    if (typeof text !== 'string') return;
    if (text === 'ping') { this.send(conn, 'pong'); return; }
    if (text.length > LIMITS.textChars + LIMITS.snapChars) { this.fail(conn, 'too-large', '消息太大'); return; }
    var meta = this.io.meta(conn);
    // 已登录的主持人不限流（发放、投票时一次要发很多条）；其他连接每分钟有上限
    if (!(meta && meta.role === 'host') && !this.allow(conn)) { this.fail(conn, 'rate', '发送太频繁，请稍后再试'); return; }
    var d;
    try { d = JSON.parse(text); } catch (e) { this.fail(conn, 'bad-json'); return; }
    if (!d || typeof d.t !== 'string') { this.fail(conn, 'bad-message'); return; }
    if (!meta || !meta.role) {
      if (d.t !== 'hello') { this.fail(conn, 'hello-first', '请先登录房间', true); return; }
      this.hello(conn, d);
      return;
    }
    this.touch();
    if (meta.role === 'host') this.fromHost(conn, d);
    else if (meta.role === 'player') this.fromPlayer(conn, meta, d);
    else if (meta.role === 'guest') this.fromGuest(conn, meta, d);
  }

  /** 连接断开：把它从在线名单里拿掉（适配层这时可能还会列出这个正在关闭的连接）。 */
  closed(conn) {
    var meta = this.io.meta(conn);
    this.rate.delete(conn);
    if (!meta || !meta.role) return;
    this.gone = conn;
    try { this.presence(); } finally { this.gone = null; }
  }

  allow(conn) {
    var now = this.io.now();
    var r = this.rate.get(conn);
    if (!r || now - r.start > 60000) { r = { start: now, n: 0 }; this.rate.set(conn, r); }
    r.n += 1;
    return r.n <= LIMITS.perMinute;
  }

  // ---------------------------------------------------------------- 登录

  hello(conn, d) {
    var io = this.io;
    var self = this;
    if (d.v !== PROTOCOL) { this.fail(conn, 'version', '页面版本和房间不一致：请刷新页面', true); return; }
    if (d.role === 'host') {
      if (!isId(d.key) || d.key !== this.room.hostKey) { this.fail(conn, 'bad-key', '主持人密钥不对', true); return; }
      // 同一时间只保留一个主持人连接，避免两个标签页重复处理同一条消息
      this.hostConns().forEach(function (c) { if (c !== conn) { self.send(c, { t: 'replaced' }); io.close(c, 4001, 'replaced'); } });
      io.setMeta(conn, { role: 'host', at: io.now() });
      this.send(conn, { t: 'welcome', role: 'host', v: PROTOCOL, code: this.room.code, players: this.bindings(), online: this.onlinePlayers(), guests: this.guestList() });
      this.deliverAll(conn, 'host');
      this.presence();
      return;
    }
    if (d.role === 'player') {
      var pid = this.pidByToken(d.token);
      if (!pid) { this.fail(conn, 'bad-token', '这台设备的加入凭证已失效：请重新加入', true); return; }
      this.playerConns(pid).forEach(function (c) { if (c !== conn) { self.send(c, { t: 'replaced' }); io.close(c, 4001, 'replaced'); } });
      io.setMeta(conn, { role: 'player', pid: pid, name: this.room.players[pid].name, at: io.now() });
      this.welcomePlayer(conn, pid);
      return;
    }
    if (d.role === 'guest') {
      if (this.guestConns().length >= LIMITS.guests) { this.fail(conn, 'full', '等待加入的人太多了', true); return; }
      var gid = makeSecret(io.rand, 10);
      io.setMeta(conn, { role: 'guest', gid: gid, pid: null, name: '', at: io.now() });
      this.send(conn, { t: 'lobby', v: PROTOCOL, code: this.room.code, gid: gid, roster: this.lobbyRoster(), hostOnline: this.hostConns().length > 0 });
      return;
    }
    this.fail(conn, 'bad-role', '未知的身份', true);
  }

  welcomePlayer(conn, pid) {
    this.send(conn, {
      t: 'welcome', role: 'player', v: PROTOCOL, code: this.room.code, you: { pid: pid, name: this.room.players[pid].name },
      snap: this.snap, online: this.onlinePlayers(), hostOnline: this.hostConns().length > 0
    });
    this.deliverAll(conn, pid);
    this.presence();
  }

  pidByToken(token) {
    if (!isId(token)) return null;
    var players = this.room.players;
    var found = null;
    Object.keys(players).forEach(function (pid) { if (players[pid].token === token) found = pid; });
    return found;
  }

  bindings() {
    var players = this.room.players;
    return Object.keys(players).map(function (pid) { return { pid: pid, name: players[pid].name, boundAt: players[pid].boundAt }; });
  }

  guestList() {
    var io = this.io;
    return this.guestConns().map(function (c) { var m = io.meta(c); return { gid: m.gid, pid: m.pid, name: m.name }; }).filter(function (g) { return g.pid || g.name; });
  }

  /** 给还没加入的人看的名单：只有名字和是否已有设备加入，没有别的公开信息。 */
  lobbyRoster() {
    var bound = this.room.players;
    var list = this.snap && Array.isArray(this.snap.players) ? this.snap.players : [];
    return list.filter(function (p) { return p && isId(p.id); }).map(function (p) {
      return { id: p.id, name: String(p.name || ''), alive: p.alive !== false, joined: !!bound[p.id] };
    });
  }

  // ---------------------------------------------------------------- 主持人发来的

  fromHost(conn, d) {
    var self = this;
    var io = this.io;
    var room = this.room;
    switch (d.t) {
      case 'pub': {
        var s = d.s;
        var size = 0;
        try { size = JSON.stringify(s).length; } catch (e) { size = Infinity; }
        if (!s || typeof s !== 'object' || size > LIMITS.snapChars) { this.fail(conn, 'bad-snap', '公开信息太大或格式不对'); return; }
        var rosterBefore = JSON.stringify(this.lobbyRoster());
        this.snap = s;
        io.save('snap');
        this.playerConns().forEach(function (c) { self.send(c, { t: 'snap', s: s }); });
        if (JSON.stringify(this.lobbyRoster()) !== rosterBefore) {
          var roster = this.lobbyRoster();
          this.guestConns().forEach(function (c) { self.send(c, { t: 'lobby', code: room.code, gid: io.meta(c).gid, roster: roster, hostOnline: true }); });
        }
        return;
      }
      case 'approve': {
        if (!isId(d.gid) || !isId(d.pid)) { this.fail(conn, 'bad-approve'); return; }
        var guest = this.guestConns().filter(function (c) { return io.meta(c).gid === d.gid; })[0];
        if (!guest) { this.fail(conn, 'guest-gone', '对方已经离开，请让他重新加入'); return; }
        if (!room.players[d.pid] && Object.keys(room.players).length >= LIMITS.players) { this.fail(conn, 'full', '房间人数已满'); return; }
        var name = String(d.name || (this.lobbyRoster().filter(function (p) { return p.id === d.pid; })[0] || {}).name || io.meta(guest).name || '').slice(0, 40);
        // 换设备：旧设备的凭证作废并断开
        this.playerConns(d.pid).forEach(function (c) { self.send(c, { t: 'replaced' }); io.close(c, 4001, 'replaced'); });
        var token = makeSecret(io.rand, 24);
        room.players[d.pid] = { name: name, token: token, boundAt: io.now() };
        io.save('room');
        this.send(guest, { t: 'approved', code: room.code, token: token, pid: d.pid, name: name });
        io.setMeta(guest, { role: 'player', pid: d.pid, name: name, at: io.now() });
        this.welcomePlayer(guest, d.pid);
        this.send(conn, { t: 'bound', players: this.bindings() });
        return;
      }
      case 'reject': {
        var g = this.guestConns().filter(function (c) { return io.meta(c).gid === d.gid; })[0];
        if (g) { this.send(g, { t: 'rejected', reason: String(d.reason || '').slice(0, 200) }); io.close(g, 4002, 'rejected'); }
        this.presence();
        return;
      }
      case 'kick': {
        if (!isId(d.pid)) return;
        this.playerConns(d.pid).forEach(function (c) { self.send(c, { t: 'kicked' }); io.close(c, 4003, 'kicked'); });
        delete room.players[d.pid];
        delete room.queues[d.pid];
        io.save('room');
        this.send(conn, { t: 'bound', players: this.bindings() });
        this.presence();
        return;
      }
      case 'send': {
        var m = d.m;
        if (!m || !isId(m.id)) { this.fail(conn, 'bad-send'); return; }
        if (!this.fresh('host', m.id)) { this.send(conn, { t: 'ok', id: m.id }); return; }
        if (!this.small(m)) { this.fail(conn, 'too-large', '消息太大', false, { id: m.id }); return; }
        var to = d.to === '*' ? Object.keys(room.players) : (Array.isArray(d.to) ? d.to : [d.to]);
        to.filter(isId).forEach(function (pid) { self.enqueue(pid, { from: 'host', fromName: '', m: m }); });
        io.save('room');
        this.send(conn, { t: 'ok', id: m.id });
        return;
      }
      case 'ack': {
        this.ack('host', d.ids);
        return;
      }
      case 'end': {
        this.conns().forEach(function (c) { if (c !== conn) { self.send(c, { t: 'ended' }); io.close(c, 4004, 'ended'); } });
        this.send(conn, { t: 'ended' });
        io.save('delete');
        io.close(conn, 4004, 'ended');
        return;
      }
      default:
        this.fail(conn, 'unknown', '未知的消息：' + d.t);
    }
  }

  // ---------------------------------------------------------------- 玩家发来的

  fromPlayer(conn, meta, d) {
    var self = this;
    var room = this.room;
    if (!room.players[meta.pid]) { this.fail(conn, 'bad-token', '你已被移出房间', true); return; }
    switch (d.t) {
      case 'up': {
        var m = d.m;
        if (!m || !isId(m.id)) { this.fail(conn, 'bad-up'); return; }
        if (!this.fresh(meta.pid, m.id)) { this.send(conn, { t: 'ok', id: m.id }); return; }
        if (!this.small(m)) { this.fail(conn, 'too-large', '消息太大', false, { id: m.id }); return; }
        this.enqueue('host', { from: meta.pid, fromName: meta.name, m: m });
        this.io.save('room');
        this.send(conn, { t: 'ok', id: m.id });
        return;
      }
      case 'p2p': {
        var p = d.m;
        if (!p || !isId(p.id) || !isId(d.to)) { this.fail(conn, 'bad-p2p'); return; }
        if (!this.knownPid(d.to)) { this.fail(conn, 'no-such-player', '名单里没有这个人', false, { id: p.id }); return; }
        if (!this.fresh(meta.pid, p.id)) { this.send(conn, { t: 'ok', id: p.id }); return; }
        if (!this.small(p)) { this.fail(conn, 'too-large', '消息太大', false, { id: p.id }); return; }
        this.enqueue(d.to, { from: meta.pid, fromName: meta.name, m: p });
        // 主持人留一份副本（只记录，不需要处理）
        this.enqueue('host', { from: meta.pid, fromName: meta.name, m: p, cc: d.to });
        this.io.save('room');
        this.send(conn, { t: 'ok', id: p.id });
        return;
      }
      case 'ack': {
        this.ack(meta.pid, d.ids);
        return;
      }
      default:
        self.fail(conn, 'unknown', '未知的消息：' + d.t);
    }
  }

  fromGuest(conn, meta, d) {
    var io = this.io;
    if (d.t !== 'request') { this.fail(conn, 'not-joined', '请等主持人通过'); return; }
    var pid = isId(d.pid) ? d.pid : null;
    var name = String(d.name || '').trim().slice(0, 40);
    if (!pid && !name) { this.fail(conn, 'bad-request', '请选择你的名字'); return; }
    io.setMeta(conn, { role: 'guest', gid: meta.gid, pid: pid, name: name, at: meta.at });
    this.send(conn, { t: 'requested', pid: pid, name: name });
    var self = this;
    this.hostConns().forEach(function (c) { self.send(c, { t: 'join', gid: meta.gid, pid: pid, name: name }); });
    this.presence();
  }

  knownPid(pid) {
    if (this.room.players[pid]) return true;
    var list = this.snap && Array.isArray(this.snap.players) ? this.snap.players : [];
    return list.some(function (p) { return p && p.id === pid; });
  }

  // ---------------------------------------------------------------- 暂存与送达

  /** 同一发送方的同一条消息（重连后重发）只收一次。 */
  fresh(sender, id) {
    var seen = this.room.seen[sender] || (this.room.seen[sender] = []);
    if (seen.indexOf(id) >= 0) return false;
    seen.push(id);
    if (seen.length > LIMITS.seen) seen.splice(0, seen.length - LIMITS.seen);
    return true;
  }

  small(m) {
    try { return JSON.stringify(m).length <= LIMITS.textChars; } catch (e) { return false; }
  }

  enqueue(to, entry) {
    var q = this.room.queues[to] || (this.room.queues[to] = []);
    var e = { id: String(++this.room.seq), from: entry.from, fromName: entry.fromName || '', m: entry.m, at: this.io.now() };
    if (entry.cc) e.cc = entry.cc;
    e.n = JSON.stringify(e.m).length;
    q.push(e);
    if (q.length > LIMITS.queue) q.splice(0, q.length - LIMITS.queue);
    this.trim();
    var self = this;
    var targets = to === 'host' ? this.hostConns() : this.playerConns(to);
    targets.forEach(function (c) { self.send(c, { t: 'msg', e: e }); });
  }

  /** 暂存的消息总量超过上限时，从积压最多的收件人那里丢最早的（只在有人很久不上线时才会发生）。 */
  trim() {
    var queues = this.room.queues;
    var size = function (e) { return e.n != null ? e.n : JSON.stringify(e.m).length; };
    var total = 0;
    Object.keys(queues).forEach(function (k) { queues[k].forEach(function (e) { total += size(e); }); });
    while (total > LIMITS.storeChars) {
      var longest = null;
      Object.keys(queues).forEach(function (k) { if (queues[k].length && (!longest || queues[k].length > queues[longest].length)) longest = k; });
      if (!longest) break;
      total -= size(queues[longest].shift());
    }
  }

  deliverAll(conn, who) {
    var q = this.room.queues[who] || [];
    var batch = [];
    var size = 0;
    var self = this;
    q.forEach(function (e) {
      var n = e.n != null ? e.n : JSON.stringify(e.m).length;
      if (batch.length && size + n > LIMITS.batchChars) {
        self.send(conn, { t: 'msgs', list: batch });
        batch = [];
        size = 0;
      }
      batch.push(e);
      size += n;
    });
    if (batch.length) this.send(conn, { t: 'msgs', list: batch });
  }

  ack(who, ids) {
    if (!Array.isArray(ids) || !ids.length) return;
    var q = this.room.queues[who];
    if (!q) return;
    var before = q.length;
    this.room.queues[who] = q.filter(function (e) { return ids.indexOf(e.id) < 0; });
    if (this.room.queues[who].length !== before) this.io.save('room');
  }

  // ---------------------------------------------------------------- 在线情况

  presence() {
    var self = this;
    var online = this.onlinePlayers();
    var hostOnline = this.hostConns().length > 0;
    var guests = this.guestList();
    this.hostConns().forEach(function (c) { self.send(c, { t: 'presence', online: online, guests: guests, hostOnline: true }); });
    this.playerConns().forEach(function (c) { self.send(c, { t: 'presence', online: online, hostOnline: hostOnline }); });
  }
}
