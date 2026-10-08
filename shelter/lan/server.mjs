#!/usr/bin/env node
/*
 * 避难所 Playtest · 局域网联机服务器
 *
 * 主持人电脑运行：node shelter-lan.mjs（需要 Node.js 18 或更新版本，不用安装别的东西）
 * 然后大家连同一个 Wi‑Fi，用窗口里显示的地址打开主持人页、玩家页即可联机。
 *
 *   --port 8787   端口（默认 8787，也可用环境变量 PORT）
 *   --data <文件> 房间数据保存位置（默认当前目录下的 shelter-lan-data.json；重开服务器不丢房间）
 *
 * 构建时（shelter/build.mjs）会把房间逻辑和三个页面一起打进单个文件 shelter-lan.mjs；
 * 开发时也可以直接 node shelter/lan/server.mjs（页面从上一级目录读）。
 * 这里自己实现了最小的 WebSocket 服务端（RFC 6455），只用 Node 自带的模块。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Room, newRoom, makeCode, makeSecret, isCode, PROTOCOL } from '../relay/src/room.js'; // @@ROOM@@

const ROOM_TTL = 14 * 24 * 3600 * 1000;
const MAX_FRAME = 4 * 1024 * 1024; // 房间逻辑自己限制消息大小（中文按 3 字节算在 1 MiB 以内）；这里只防异常大的帧
const PAGE_FILES = { '/index.html': 'index.html', '/host.html': 'host.html', '/player.html': 'player.html' };

function loadPagesFromDisk() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = {};
  Object.keys(PAGE_FILES).forEach((k) => { out[k] = fs.readFileSync(path.join(dir, PAGE_FILES[k]), 'utf8'); });
  return out;
}

const PAGES = loadPagesFromDisk(); // @@PAGES@@

// ---------------------------------------------------------------- 参数

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

let PORT = parseInt(arg('port', process.env.PORT || '8787'), 10);
let DATA_FILE = path.resolve(arg('data', 'shelter-lan-data.json'));
let QUIET = process.argv.includes('--quiet');

function lanUrls() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((n) => {
      const v4 = n.family === 'IPv4' || n.family === 4;
      if (v4 && !n.internal) out.push('http://' + n.address + ':' + PORT);
    });
  });
  return out;
}

// ---------------------------------------------------------------- 最小 WebSocket

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WsConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOp = 0;
    this.open = true;
    this.meta = null;
    this.lastSeen = Date.now();
    this.ended = false;
    socket.on('data', (d) => this.feed(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  feed(data) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    this.lastSeen = Date.now();
    try { this.parse(); } catch (e) { this.fail(1002); }
  }

  parse() {
    for (;;) {
      if (!this.open || this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        if (this.buf.readUInt32BE(2) !== 0) { this.fail(1009); return; }
        len = this.buf.readUInt32BE(6);
        off = 10;
      }
      if (len > MAX_FRAME) { this.fail(1009); return; }
      if (!masked) { this.fail(1002); return; } // 浏览器发来的帧必须带掩码
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + len);
      if (op === 0x8) { // 关闭
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        this.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000);
        return;
      }
      if (op === 0x9) { this.frame(0xA, payload); continue; } // ping → pong
      if (op === 0xA) continue; // pong
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        if (op !== 0) { this.fragOp = op; this.frags = []; }
        this.frags.push(payload);
        if (this.frags.reduce((n, b) => n + b.length, 0) > MAX_FRAME) { this.fail(1009); return; }
        if (fin) {
          const msg = Buffer.concat(this.frags);
          this.frags = [];
          if (this.fragOp === 0x1) this.emit('message', msg.toString('utf8'));
        }
        continue;
      }
      this.fail(1002);
      return;
    }
  }

  frame(op, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text) {
    this.frame(0x1, Buffer.from(String(text), 'utf8'));
  }

  ping() {
    this.frame(0x9, Buffer.alloc(0));
  }

  close(code, reason) {
    if (!this.open) return;
    const r = Buffer.from(String(reason || '').slice(0, 100), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code || 1000, 0);
    r.copy(p, 2);
    try { this.frame(0x8, p); } catch (e) { /* 忽略 */ }
    this.open = false;
    this.socket.end();
    this.finish();
  }

  fail(code) {
    this.close(code);
    this.socket.destroy();
  }

  finish() {
    this.open = false;
    if (this.ended) return;
    this.ended = true;
    this.emit('close');
  }
}

function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const conn = new WsConn(socket);
  if (head && head.length) conn.feed(head);
  return conn;
}

// ---------------------------------------------------------------- 房间（和云端同一份逻辑）

const rooms = new Map(); // code → { room, snap, conns: Set, core }
let saveTimer = null;

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const now = Date.now();
    (data.rooms || []).forEach((r) => {
      if (r && r.room && isCode(r.room.code) && now - (r.room.lastActive || 0) < ROOM_TTL) rooms.set(r.room.code, makeEntry(r.room, r.snap));
    });
  } catch (e) { /* 第一次运行没有数据文件 */ }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

function saveNow() {
  const data = { v: 1, savedAt: Date.now(), rooms: [...rooms.values()].map((e) => ({ room: e.room, snap: e.core.snap })) };
  try {
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(data));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (e) {
    if (!QUIET) console.error('保存房间数据失败：' + e.message);
  }
}

function makeEntry(room, snap) {
  const entry = { room, snap: snap || null, conns: new Set(), core: null };
  const io = {
    conns: () => [...entry.conns].filter((c) => c.open),
    meta: (c) => c.meta,
    setMeta: (c, m) => { c.meta = m; },
    send: (c, obj) => c.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
    close: (c, code, reason) => c.close(code, reason),
    now: () => Date.now(),
    rand: () => crypto.randomInt(0, 0x100000000) / 0x100000000,
    save: (kind) => {
      if (kind === 'delete') rooms.delete(room.code);
      scheduleSave();
    }
  };
  entry.core = new Room(room, snap, io);
  return entry;
}

function createRoom() {
  const rand = () => crypto.randomInt(0, 0x100000000) / 0x100000000;
  for (let i = 0; i < 20; i++) {
    const code = makeCode(rand, 5);
    if (rooms.has(code)) continue;
    const room = newRoom(code, makeSecret(rand, 24), Date.now());
    rooms.set(code, makeEntry(room, null));
    scheduleSave();
    return room;
  }
  return null;
}

// ---------------------------------------------------------------- HTTP

function lanScript() {
  return '<script>window.SHELTER_LAN = ' + JSON.stringify({ v: PROTOCOL, urls: lanUrls() }).replace(/</g, '\\u003c') + ';</script>';
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(obj));
}

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }
  if (url.pathname === '/health') { sendJson(res, 200, { ok: true, service: 'shelter-lan', v: PROTOCOL, rooms: rooms.size }); return; }
  if (url.pathname === '/api/rooms') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'method' }); return; }
    const room = createRoom();
    if (!room) { sendJson(res, 503, { error: 'busy' }); return; }
    sendJson(res, 200, { code: room.code, hostKey: room.hostKey, v: PROTOCOL });
    return;
  }
  const page = url.pathname === '/' ? '/index.html' : url.pathname;
  if (PAGES[page] && (req.method === 'GET' || req.method === 'HEAD')) {
    // 告诉页面「这是局域网服务器」：联机默认连本机，二维码用局域网地址
    const html = PAGES[page].replace(/<head>/i, '<head>' + lanScript());
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : html);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
}

function upgrade(req, socket, head) {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]{4,8})$/);
  if (!m) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
  const conn = acceptWebSocket(req, socket, null);
  if (!conn) return;
  const code = m[1].toUpperCase();
  const entry = rooms.get(code);
  if (!entry) {
    conn.send(JSON.stringify({ t: 'err', code: 'no-room', message: '房间不存在或已经结束' }));
    conn.close(4404, 'no-room');
    return;
  }
  entry.conns.add(conn);
  conn.on('message', (text) => {
    entry.room.lastActive = Date.now();
    entry.core.message(conn, text);
  });
  conn.on('close', () => {
    entry.conns.delete(conn);
    entry.core.closed(conn);
  });
  if (head && head.length) conn.feed(head);
}

/** 启动服务器。opts：port（0＝随机端口）、host、data（数据文件）、quiet（不打印）。返回 http.Server。 */
export function startServer(opts) {
  opts = opts || {};
  if (opts.port != null) PORT = opts.port;
  if (opts.data) DATA_FILE = path.resolve(opts.data);
  if (opts.quiet) QUIET = true;
  rooms.clear();
  loadData();
  const server = http.createServer(handle);
  server.on('upgrade', upgrade);
  // 每 30 秒探一次连接；90 秒没有任何数据的连接视为断开
  const beat = setInterval(() => {
    const now = Date.now();
    rooms.forEach((e) => e.conns.forEach((c) => {
      if (now - c.lastSeen > 90000) c.fail(1001);
      else { try { c.ping(); } catch (err) { /* 忽略 */ } }
    }));
  }, 30000);
  // 关服务器时先断开所有联机连接（升级成 WebSocket 的连接不归 http 服务器管），再保存房间
  const close = server.close.bind(server);
  server.close = (cb) => {
    clearInterval(beat);
    rooms.forEach((e) => e.conns.forEach((c) => c.fail(1001)));
    clearTimeout(saveTimer);
    saveNow();
    return close(cb);
  };
  server.listen(PORT, opts.host || '0.0.0.0', () => {
    PORT = server.address().port;
    if (QUIET) return;
    const urls = lanUrls();
    console.log('\n避难所 Playtest · 局域网联机服务器已启动（Ctrl+C 停止）\n');
    if (!urls.length) console.log('  没有找到局域网地址：请先连上 Wi‑Fi 或网线。本机可用 http://localhost:' + PORT);
    urls.forEach((u) => {
      console.log('  主持人页：' + u + '/host.html');
      console.log('  玩家页：  ' + u + '/player.html');
    });
    console.log('\n  玩家和主持人要连同一个网络；主持人页开好房间后会显示二维码，玩家扫码加入。');
    console.log('  房间数据保存在：' + DATA_FILE + '\n');
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = startServer();
  const stop = () => { server.close(); setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
