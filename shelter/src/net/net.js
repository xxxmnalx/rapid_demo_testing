/*
 * 避难所 Playtest · 联机（浏览器端连接）
 *
 * 主持人页、玩家页共用：建房间、带自动重连的 WebSocket 连接、待发队列（断线时先存着，连上再发）、
 * 已处理消息记录（同一条消息不会处理两次）、同一浏览器只让一个标签页联机。
 * 游戏逻辑不在这里：收到的消息交给页面自己处理，处理成功才回 ack，房间才删掉这条消息。
 *
 * 服务器：
 *   - 局域网：页面由局域网服务器（shelter-lan.mjs）打开时有 window.SHELTER_LAN，直接连这台电脑；
 *   - 云端：默认 https://shelter-rt.xxxmnalx.com（Cloudflare），主持人可以在联机页改成别的地址。
 * 房间协议见 shelter/relay/src/room.js。
 */
(function (root) {
  'use strict';

  var PROTOCOL = 1;
  var DEFAULT_SERVER = 'https://shelter-rt.xxxmnalx.com';
  var FATAL = { 'bad-key': 1, 'bad-token': 1, version: 1, 'no-room': 1 };

  function readJSON(key, fallback) {
    try {
      var v = JSON.parse(root.localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function writeJSON(key, v) {
    try { root.localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 本地存储不可用：只在内存里 */ }
  }

  function removeKey(key) {
    try { root.localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
  }

  function uid(prefix) {
    return (prefix || 'm') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function lan() {
    return root.SHELTER_LAN || null;
  }

  /** 服务器地址（http/https 开头，不带结尾斜杠）。custom 优先，其次局域网服务器本身，最后默认云端。 */
  function serverBase(custom) {
    if (custom && /^https?:\/\/[^\s/]+[^\s]*$/i.test(custom)) return custom.replace(/\/+$/, '');
    if (lan() && root.location && /^https?:$/.test(root.location.protocol)) return root.location.origin;
    return DEFAULT_SERVER;
  }

  function wsUrl(base, code) {
    return base.replace(/^http/i, 'ws') + '/ws/' + code;
  }

  function createRoom(base) {
    return fetch(base + '/api/rooms', { method: 'POST' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /** 玩家页地址：和主持人页同一目录下的 player.html（局域网时用局域网地址，方便手机扫码）。 */
  function playerPageUrl() {
    var u = root.location.href.replace(/[#?].*$/, '');
    var info = lan();
    if (info && info.urls && info.urls.length && /^(localhost|127\.|\[?::1)/.test(root.location.hostname)) {
      u = info.urls[0] + root.location.pathname;
    }
    if (/host(\.html)?$/.test(u)) return u.replace(/host(\.html)?$/, 'player.html');
    try { return new URL('player.html', u).href; } catch (e) { return 'player.html'; }
  }

  /** 加入链接：玩家页地址 + #join=房间码；服务器不是默认云端、也不是局域网本机时带上 &s=。 */
  function joinLink(code, base) {
    var link = playerPageUrl() + '#join=' + code;
    var own = lan() ? root.location.origin : null;
    if (base && base !== DEFAULT_SERVER && base !== own) link += '&s=' + encodeURIComponent(base);
    return link;
  }

  function parseJoin(hash) {
    var m = /#join=([A-Za-z0-9]{4,8})(?:&s=([^&]+))?/.exec(hash || '');
    if (!m) return null;
    var base = null;
    if (m[2]) { try { base = decodeURIComponent(m[2]); } catch (e) { base = null; } }
    return { code: m[1].toUpperCase(), base: base };
  }

  // ---------------------------------------------------------------- 连接

  /**
   * 一条带自动重连的连接。opts：
   *   base、code：服务器与房间码
   *   hello()：返回登录信息 { role, key | token }（每次连上时调用，拿到的总是最新凭证）
   *   store：本地存储前缀（待发队列、已处理消息）
   *   onMessage(entry)：收到一条消息 { id, from, fromName, m, at, cc }；返回 false 表示这次没处理，下次再送
   *   on(type, data)：其他事件：status、welcome、lobby、snap、presence、join、requested、approved、
   *                   bound、rejected、replaced、kicked、ended、error（带 id 时是某一条消息没送出）、sent（房间收下了某一条）
   */
  function Link(opts) {
    this.opts = opts;
    this.ws = null;
    this.status = 'idle';
    this.info = null;
    this.retry = 0;
    this.timer = null;
    this.beat = null;
    this.stopped = true;
    this.fatal = null;
    this.outbox = readJSON(opts.store + ':outbox', []);
    this.done = readJSON(opts.store + ':done', []);
  }

  Link.prototype.start = function () {
    this.stopped = false;
    this.fatal = null;
    this.retry = 0;
    this.connect();
  };

  Link.prototype.stop = function () {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.beat);
    var ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(1000, 'bye'); } catch (e) { /* 忽略 */ } }
    this.setStatus('idle');
  };

  Link.prototype.setStatus = function (status, info) {
    if (this.status === status && this.info === (info || null)) return;
    this.status = status;
    this.info = info || null;
    this.emit('status', { status: status, info: this.info });
  };

  Link.prototype.emit = function (type, data) {
    try { if (this.opts.on) this.opts.on(type, data); } catch (e) { if (root.console) root.console.error(e); }
  };

  Link.prototype.connect = function () {
    var self = this;
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.setStatus(this.retry ? 'reconnecting' : 'connecting');
    var ws;
    try { ws = new WebSocket(wsUrl(this.opts.base, this.opts.code)); } catch (e) { this.schedule(); return; }
    this.ws = ws;
    ws.onopen = function () {
      if (self.ws !== ws) return;
      var hello = self.opts.hello();
      hello.t = 'hello';
      hello.v = PROTOCOL;
      ws.send(JSON.stringify(hello));
      clearInterval(self.beat);
      // 25 秒一次心跳：云端由运行时直接回 pong，不会唤醒房间
      self.beat = setInterval(function () { if (ws.readyState === 1) ws.send('ping'); }, 25000);
    };
    ws.onmessage = function (ev) {
      if (self.ws !== ws || ev.data === 'pong') return;
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      self.handle(d);
    };
    ws.onclose = function () {
      if (self.ws !== ws) return;
      clearInterval(self.beat);
      self.ws = null;
      if (self.fatal) { self.stopped = true; self.setStatus('stopped', self.fatal); return; }
      if (!self.stopped) self.schedule();
    };
    ws.onerror = function () { /* onclose 会紧跟着来 */ };
  };

  Link.prototype.schedule = function () {
    var self = this;
    var delay = Math.min(15000, 800 * Math.pow(2, Math.min(this.retry, 5))) * (0.75 + Math.random() * 0.5);
    this.retry += 1;
    this.setStatus('reconnecting');
    this.timer = setTimeout(function () { self.connect(); }, delay);
  };

  /** 立刻重连（页面回到前台、网络恢复时用）。 */
  Link.prototype.wake = function () {
    if (!this.stopped && !this.ws) {
      this.retry = 0;
      this.connect();
    }
  };

  Link.prototype.handle = function (d) {
    switch (d.t) {
      case 'welcome':
        this.retry = 0;
        this.setStatus('online');
        this.emit('welcome', d);
        this.flush();
        break;
      case 'lobby':
        this.retry = 0;
        this.setStatus('lobby');
        this.emit('lobby', d);
        break;
      case 'ok':
        this.dropOutbox(d.id);
        this.emit('sent', d);
        break;
      case 'msg':
        this.receive([d.e]);
        break;
      case 'msgs':
        this.receive(d.list || []);
        break;
      case 'err':
        if (FATAL[d.code]) this.fatal = d.code;
        // 某一条消息出错（太大、收件人不存在）：不再重发
        if (d.id) this.dropOutbox(d.id);
        this.emit('error', d);
        break;
      case 'replaced':
      case 'kicked':
      case 'ended':
      case 'rejected':
        this.fatal = d.t;
        this.emit(d.t, d);
        break;
      default:
        this.emit(d.t, d);
    }
  };

  Link.prototype.receive = function (list) {
    var self = this;
    var ack = [];
    list.forEach(function (e) {
      if (!e || !e.id) return;
      var key = (e.from || '') + ':' + (e.m && e.m.id ? e.m.id : e.id);
      if (self.done.indexOf(key) >= 0) { ack.push(e.id); return; }
      var ok;
      try { ok = self.opts.onMessage(e) !== false; } catch (err) { ok = false; if (root.console) root.console.error(err); }
      if (ok) {
        self.done.push(key);
        ack.push(e.id);
      }
    });
    if (this.done.length > 800) this.done.splice(0, this.done.length - 800);
    writeJSON(this.opts.store + ':done', this.done);
    if (ack.length) this.raw({ t: 'ack', ids: ack });
  };

  /**
   * 一定要送到的消息：先进待发队列（断线、刷新都不丢），房间回 ok 后才删掉。
   * frame：{ t: 'up' | 'p2p' | 'send', to?, m }。返回消息 id。
   */
  Link.prototype.post = function (frame) {
    frame.m = frame.m || {};
    if (!frame.m.id) frame.m.id = uid();
    this.outbox.push(frame);
    if (this.outbox.length > 300) this.outbox.splice(0, this.outbox.length - 300);
    writeJSON(this.opts.store + ':outbox', this.outbox);
    if (this.status === 'online') this.raw(frame);
    return frame.m.id;
  };

  Link.prototype.dropOutbox = function (id) {
    var before = this.outbox.length;
    this.outbox = this.outbox.filter(function (f) { return !f.m || f.m.id !== id; });
    if (this.outbox.length !== before) writeJSON(this.opts.store + ':outbox', this.outbox);
  };

  Link.prototype.flush = function () {
    var self = this;
    this.outbox.forEach(function (f) { self.raw(f); });
  };

  /** 不需要排队的消息（公开信息、ack、通过加入）：在线就发，不在线就算了（重连后会重发最新的）。 */
  Link.prototype.raw = function (obj) {
    var ws = this.ws;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  };

  Link.prototype.pending = function () {
    return this.outbox.length;
  };

  /** 离开房间时清掉本地的待发队列和已处理记录。 */
  Link.prototype.forget = function () {
    removeKey(this.opts.store + ':outbox');
    removeKey(this.opts.store + ':done');
    this.outbox = [];
    this.done = [];
  };

  // ---------------------------------------------------------------- 同一浏览器只让一个标签页联机

  /** 持有的标签页每 4 秒续一次；75 秒没续就算放弃（后台标签页的计时器可能被浏览器放慢到一分钟一次）。 */
  function TabLock(key) {
    this.key = key;
    this.id = uid('tab');
    this.timer = null;
  }

  TabLock.prototype.holder = function () {
    var v = readJSON(this.key, null);
    return v && Date.now() - v.at < 75000 ? v.id : null;
  };

  TabLock.prototype.mine = function () {
    var h = this.holder();
    return !h || h === this.id;
  };

  TabLock.prototype.take = function () {
    var self = this;
    var tick = function () { writeJSON(self.key, { id: self.id, at: Date.now() }); };
    tick();
    clearInterval(this.timer);
    this.timer = setInterval(tick, 4000);
    if (!this.bound) {
      this.bound = true;
      root.addEventListener('pagehide', function () { self.release(); });
    }
  };

  TabLock.prototype.release = function () {
    clearInterval(this.timer);
    this.timer = null;
    if (this.holder() === this.id) removeKey(this.key);
  };

  // ---------------------------------------------------------------- 二维码（主持人页用）

  /** 画成 SVG（深色方块），qrcode 库由主持人页内联；没有库时返回 null。 */
  function qrSvg(text, size) {
    if (typeof root.qrcode !== 'function') return null;
    var qr = root.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount();
    var margin = 2;
    var dim = n + margin * 2;
    var d = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) if (qr.isDark(r, c)) d += 'M' + (c + margin) + ' ' + (r + margin) + 'h1v1h-1z';
    }
    var ns = 'http://www.w3.org/2000/svg';
    var svg = root.document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + dim + ' ' + dim);
    svg.setAttribute('width', String(size || 200));
    svg.setAttribute('height', String(size || 200));
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    var bg = root.document.createElementNS(ns, 'rect');
    bg.setAttribute('width', String(dim));
    bg.setAttribute('height', String(dim));
    bg.setAttribute('fill', '#fff');
    var path = root.document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#111');
    svg.appendChild(bg);
    svg.appendChild(path);
    return svg;
  }

  root.ShelterNet = {
    PROTOCOL: PROTOCOL,
    DEFAULT_SERVER: DEFAULT_SERVER,
    lan: lan,
    serverBase: serverBase,
    wsUrl: wsUrl,
    createRoom: createRoom,
    playerPageUrl: playerPageUrl,
    joinLink: joinLink,
    parseJoin: parseJoin,
    Link: Link,
    TabLock: TabLock,
    qrSvg: qrSvg,
    uid: uid,
    readJSON: readJSON,
    writeJSON: writeJSON,
    removeKey: removeKey
  };
})(typeof window !== 'undefined' ? window : this);
