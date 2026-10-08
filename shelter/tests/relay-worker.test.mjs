// 联机中转（Cloudflare Worker + Durable Object）：用 wrangler dev 在本机的 workerd 上跑同一套协议测试。
// 需要先在 shelter/relay 里 npm install。运行：node --test tests/relay-worker.test.mjs
import { test, after } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProtocol, runLarge } from './relay-protocol.mjs';

const RELAY = join(dirname(fileURLToPath(import.meta.url)), '..', 'relay');
const PORT = 8800 + Math.floor(Math.random() * 100);
const base = 'http://127.0.0.1:' + PORT;
let proc = null;
let output = '';

after(() => { if (proc) proc.kill('SIGTERM'); });

test('Cloudflare 中转（本机 workerd）：完整协议与 Durable Object 持久化', { skip: !existsSync(join(RELAY, 'node_modules', 'wrangler')) && '先在 shelter/relay 里 npm install' }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'shelter-wrangler-'));
  proc = spawn(join(RELAY, 'node_modules', '.bin', 'wrangler'), ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state, '--show-interactive-dev-session=false'], {
    cwd: RELAY, env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', CI: '1' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    await new Promise((res) => setTimeout(res, 500));
    try { up = (await fetch(base + '/health')).ok; } catch (e) { /* 还没起来 */ }
  }
  if (!up) throw new Error('wrangler dev 没有启动：\n' + output.slice(-2000));
  try {
    await runProtocol(base, { label: 'Worker' });
    await runLarge(base);
  } catch (e) {
    e.message += '\n--- wrangler 输出 ---\n' + output.slice(-3000);
    throw e;
  }
});
