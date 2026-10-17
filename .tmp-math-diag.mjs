import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import http from 'node:http';
const killTree = (c) => { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); else c.kill('SIGKILL'); };
import { spawnSync } from 'node:child_process';
const chrome = spawn('C://Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--window-size=1300,1200', 'about:blank'], { stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => setTimeout(r, 1200));
// 复用 verify 的 server 启动方式：直接用 dist 的 http server
const server = http.createServer((req, res) => {
  const p = req.url === '/' ? '/index.html' : req.url;
  try { res.end(readFileSync(resolve('apps/web/dist', '.' + p.split('?')[0]))); } catch { res.end('nf'); }
}).listen(4173);
const list = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
const target = list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map(); let seq = 0;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const rpc = (method, params) => new Promise((res) => { seq += 1; pending.set(seq, res); ws.send(JSON.stringify({ id: seq, method, params })); });
const ev = async (expr) => {
  const r = await rpc('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r?.result?.value;
};
await rpc('Runtime.enable');
await rpc('Page.enable');
await rpc('Page.navigate', { url: 'http://127.0.0.1:4173/' });
await new Promise((r) => setTimeout(r, 1500));
for (let i = 0; i < 20; i += 1) { if (await ev(`!!document.querySelector('.cm-content')`).catch(() => false)) break; await sleep(500); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sleep2(ms) { return new Promise((r) => setTimeout(r, ms)); }
const sleepFn = typeof sleep === 'function' ? sleep : sleep2;
await ev(`document.querySelector('.cm-content').focus()`);
await ev(`document.execCommand('insertText', false, ${JSON.stringify(readFileSync(resolve('test/math.md'), 'utf8'))})`);
await sleepFn(800);
// 滚动到各视口，收集未渲染占位
const report = await ev(`(async () => {
  const scroller = document.querySelector('.cm-scroller');
  const out = [];
  for (let y = 0; y <= scroller.scrollHeight; y += 900) {
    scroller.scrollTop = y;
    await new Promise((r) => setTimeout(r, 400));
    document.querySelectorAll('.cm-md-block [data-tex]').forEach((el) => {
      if (!el.querySelector('.katex')) out.push({ at: y, tex: (el.getAttribute('data-tex') ?? '').slice(0, 60) });
    });
  }
  return { total: document.querySelectorAll('.cm-md-block .katex').length, pending: out.slice(0, 6) };
})()`);
console.log(JSON.stringify(report, null, 1));
killTree(chrome); server.close();
process.exit(0);
