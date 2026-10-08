/*
 * 避难所 Playtest · 联机中转（Cloudflare Worker + Durable Object）
 *
 *   POST /api/rooms      新建房间，返回 { code, hostKey }
 *   GET  /ws/<房间码>    WebSocket：主持人、玩家、等待加入的人都从这里连进房间
 *   GET  /health         检查服务是否在线
 *
 * 一个房间就是一个 Durable Object（按房间码取），房间逻辑在 room.js（和局域网服务器共用）。
 * 用 WebSocket Hibernation：没人说话时房间休眠、不计时长；浏览器每 25 秒发的 "ping" 由运行时直接回 "pong"，不会唤醒房间。
 * 房间 14 天没有动静会自动删除。
 */
import { DurableObject } from 'cloudflare:workers';
import { Room, newRoom, makeCode, makeSecret, isCode, PROTOCOL } from './room.js';

const ROOM_TTL = 14 * 24 * 3600 * 1000;

function rand() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

function corsHeaders(extra) {
  const h = new Headers(extra || {});
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Access-Control-Max-Age', '86400');
  return h;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  });
}

export class ShelterRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.snap = null;
    this.core = null;
    this.dirty = {};
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) || null;
      this.snap = (await ctx.storage.get('snap')) || null;
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** 新建房间（Worker 通过 RPC 调用）。房间码已被占用时返回 false。 */
  async create(code, hostKey) {
    if (this.room) return false;
    const now = Date.now();
    this.room = newRoom(code, hostKey, now);
    this.snap = null;
    this.core = null;
    await this.ctx.storage.put('room', this.room);
    await this.ctx.storage.setAlarm(now + ROOM_TTL);
    return true;
  }

  io() {
    const ctx = this.ctx;
    const self = this;
    return {
      conns: () => ctx.getWebSockets(),
      meta: (ws) => { try { return ws.deserializeAttachment(); } catch (e) { return null; } },
      setMeta: (ws, m) => ws.serializeAttachment(m),
      send: (ws, obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
      close: (ws, code, reason) => { try { ws.close(code, reason); } catch (e) { /* 已经关了 */ } },
      now: () => Date.now(),
      rand: rand,
      save: (kind) => { self.dirty[kind] = true; }
    };
  }

  coreRoom() {
    if (!this.core) this.core = new Room(this.room, this.snap, this.io());
    return this.core;
  }

  /** 把这次处理改动过的部分写回存储（房间整体、公开信息分开存）。 */
  async flush() {
    const d = this.dirty;
    this.dirty = {};
    if (d.delete) {
      this.room = null;
      this.snap = null;
      this.core = null;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    if (this.core) this.snap = this.core.snap;
    if (d.room) await this.ctx.storage.put('room', this.room);
    if (d.snap) await this.ctx.storage.put('snap', this.snap);
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    if (!this.room) {
      // 房间不存在（输错房间码或已过期）：告诉对方原因再关
      server.send(JSON.stringify({ t: 'err', code: 'no-room', message: '房间不存在或已经结束' }));
      server.close(4404, 'no-room');
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (!this.room) {
      try { ws.send(JSON.stringify({ t: 'ended' })); ws.close(4004, 'ended'); } catch (e) { /* 忽略 */ }
      return;
    }
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    this.coreRoom().message(ws, text);
    await this.flush();
  }

  async webSocketClose(ws) {
    if (!this.room) return;
    this.coreRoom().closed(ws);
    await this.flush();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  /** 14 天没有动静就删除房间；有动静就顺延。 */
  async alarm() {
    if (!this.room) return;
    const due = this.room.lastActive + ROOM_TTL;
    if (Date.now() < due) { await this.ctx.storage.setAlarm(due); return; }
    this.ctx.getWebSockets().forEach((ws) => { try { ws.send(JSON.stringify({ t: 'ended' })); ws.close(4004, 'ended'); } catch (e) { /* 忽略 */ } });
    this.room = null;
    this.snap = null;
    this.core = null;
    await this.ctx.storage.deleteAll();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'shelter-rt', v: PROTOCOL });
    if (url.pathname === '/api/rooms') {
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      for (let i = 0; i < 6; i++) {
        const code = makeCode(rand, 5);
        const hostKey = makeSecret(rand, 24);
        if (await env.ROOMS.getByName(code).create(code, hostKey)) return json({ code, hostKey, v: PROTOCOL });
      }
      return json({ error: 'busy' }, 503);
    }
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]{4,8})$/);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
      const code = m[1].toUpperCase();
      if (!isCode(code)) return json({ error: 'bad code' }, 400);
      return env.ROOMS.getByName(code).fetch(request);
    }
    return json({ error: 'not found' }, 404);
  }
};
