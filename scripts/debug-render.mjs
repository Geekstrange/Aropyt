/**
 * 诊断 Typora 渲染为何未生效。
 * 抓控制台报错 + 检查装饰相关 DOM/CSS 是否真的进入了页面。
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';

/**
 * 关掉整个浏览器进程树。
 *
 * `child.kill()` 在 Windows 上**只终止自己 spawn 的那个进程**，而 headless
 * Chrome 是一棵进程树（renderer / GPU / 网络服务）。子进程活下来会继续占着
 * CDP 端口，并带着上一次的 localStorage —— 下一个闸门连上去，看到的就是
 * "上一个实例的现场"：症状是某个断言莫名其妙地从一个非默认值开始
 * （实测拖宽用例起始就是 800 而非默认 650）。
 * 所以必须按树杀（taskkill /T /F）。
 */
const killBrowserTree = (child) => {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
};


const ROOT = resolve('apps/web/dist');
const PORT = 4398;
const CDP_PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
const server = createServer((req, res) => {
  const p = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const rel = p.split('/').filter((s) => s && s !== '.' && s !== '..');
  let f = join(ROOT, ...rel);
  if (resolve(f) !== ROOT && !resolve(f).startsWith(ROOT + sep)) return void res.writeHead(403).end();
  try {
    if (statSync(f).isDirectory()) f = join(f, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
    res.end(readFileSync(f));
  } catch {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(ROOT, 'index.html')));
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'aropyt-dbg-'))}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const CDP = `http://127.0.0.1:${CDP_PORT}`;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${CDP}/json/version`)).ok) break; } catch {}
    if (i > 60) throw new Error('DevTools 未就绪');
    await sleep(400);
  }

  const target = await (await fetch(`${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/`)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });

  const pending = new Map();
  let seq = 0;
  const logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[EXCEPTION] ' + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text));
    }
    const cb = pending.get(m.id);
    if (cb) { pending.delete(m.id); cb(m); }
  };
  const rpc = (method, params = {}) => new Promise((res2, rej) => {
    const id = ++seq;
    const t = setTimeout(() => rej(new Error(method + ' 超时')), 20000);
    pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ': ' + m.error.message)) : res2(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => (await rpc('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;

  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await sleep(4500);

  await ev(`document.querySelector('.cm-content')?.focus(); 1`);
  await rpc('Input.insertText', { text: '# 标题一\n\n**粗体**文字\n\n- 项目\n' });
  await sleep(2500);

  console.log('── 控制台 ──');
  console.log(logs.length ? logs.slice(0, 15).join('\n') : '(无输出)');

  console.log('\n── 探测 ──');
  console.log(await ev(`(() => {
    const styleText = [...document.querySelectorAll('style')].map(s => s.textContent || '').join('');
    return JSON.stringify({
      // 我们的 baseTheme 是否注入了样式？
      hasInlineTheme: styleText.includes('cm-md-h1'),
      hasTyporaTheme: styleText.includes('typora') || /max-width:\\s*46em/.test(styleText),
      // 编辑器里有没有任何装饰类
      decoratedLines: document.querySelectorAll('[class*="cm-md-"]').length,
      lineClasses: [...document.querySelectorAll('.cm-line')].slice(0,6).map(l => l.className),
      // 文档内容与 DOM 文本
      docText: window.__aropytDebug?.text?.() ?? null,
      domText: (document.querySelector('.cm-content')?.textContent ?? '').slice(0, 60),
      styleCount: document.querySelectorAll('style').length,
    }, null, 2);
  })()`));
  ws.close();
} catch (e) {
  console.error('诊断失败:', e.message);
} finally {
  killBrowserTree(chrome); server.close(); await sleep(400);
}
process.exit(0);
