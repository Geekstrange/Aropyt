/**
 * 编辑区布局的闸门。
 *
 * 分栏预览面板已整体移除，编辑区独占整列 —— 于是"长单行把内容撑破、
 * 横向溢出几千像素"这个问题没有了缓冲，必须由编辑区自己扛住。
 *
 * 三个曾经踩过的坑（都在源码模式那一侧）：
 * 1. .app-main 的 flex basis 曾经是 auto —— basis 取内容宽度，
 *    一条超长单行把这一列撑到两万多像素。basis 必须归零（1 1 0）。
 * 2. 源码模式的 .cm-content 不折行（CM6 默认 white-space: pre）。
 * 3. 只改 white-space 不够：CM6 给 content 设了 flex-shrink: 0
 *    （永不收缩），渲染态在 inline-render.ts 补过 flexShrink/minWidth，
 *    源码模式是同一颗雷 —— 不补的话实测仍横向溢出 26054px。
 *
 * 顺带断言预览面板**确实不在了**（它被移除后不该再有第二列）。
 *
 * 用法：npm run check:layout
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';

const ROOT = resolve('apps/web/dist');
const PORT = 4420;
const CDP_PORT = 9359;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

/** 关掉整个浏览器进程树（Windows 上 child.kill() 只杀主进程）。 */
const killBrowserTree = (child) => {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
};

const server = createServer((req, res) => {
  const p = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const f = join(ROOT, p === '/' ? '/index.html' : p);
  if (!existsSync(f)) { res.writeHead(404); res.end('x'); return; }
  res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--hide-scrollbars',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'aropyt-lay-'))}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const problems = [];
const pass = (m) => console.log('  ✓ ' + m);
const note = (m) => { problems.push(m); console.log('  ✗ ' + m); };

try {
  for (let i = 0; ; i += 1) {
    try { if ((await fetch(`${CDP}/json/version`)).ok) break; } catch { /* retry */ }
    if (i > 60) throw new Error('DevTools 未就绪');
    await sleep(400);
  }
  const target = await (await fetch(
    `${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/`)}`,
    { method: 'PUT' },
  )).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res2, rej) => { ws.onopen = res2; ws.onerror = () => rej(new Error('ws')); });

  const pending = new Map();
  let seq = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const cb = pending.get(m.id);
    if (cb) { pending.delete(m.id); cb(m); }
  };
  const rpc = (method, params = {}) => new Promise((res2, rej) => {
    const id = ++seq;
    const t = setTimeout(() => rej(new Error(method + ' 超时')), 20000);
    pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res2(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面内异常');
    return r.result?.value;
  };

  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Emulation.setDeviceMetricsOverride', {
    width: 1300, height: 850, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(1200);
  for (let i = 0; i < 24; i += 1) {
    if (await ev(`!!document.querySelector('.cm-content')`).catch(() => false)) break;
    await sleep(500);
  }

  const measure = () => ev(`(() => {
    const main = document.querySelector('.app-main');
    const content = document.querySelector('.cm-content');
    const scroller = document.querySelector('.cm-scroller');
    const cs = content ? getComputedStyle(content) : null;
    return {
      hasPanelColumn: !!document.querySelector('.view-column--right'),
      mainW: main ? Math.round(main.getBoundingClientRect().width) : null,
      contentW: content ? Math.round(content.getBoundingClientRect().width) : null,
      scrollerClient: scroller ? scroller.clientWidth : null,
      ws: cs ? cs.whiteSpace : null,
      flexShrink: cs ? cs.flexShrink : null,
      minWidth: cs ? cs.minWidth : null,
      overflowX: scroller ? Math.round(scroller.scrollWidth - scroller.clientWidth) : null,
    };
  })()`);

  const initial = await measure();
  console.log('初始：', JSON.stringify(initial), '\n');
  console.log('── 断言 ──');

  initial.hasPanelColumn
    ? note('分栏预览面板仍���在 DOM 里（它已被整体移除）')
    : pass('分栏预览面板已不存在（编辑区独占整列）');

  // 灌一条 3000 字符的无空格长行 —— 没有空格，pre-wrap 折不了它，
  // 只有 overflow-wrap: anywhere 能兜住。
  const longLine = 'X'.repeat(3000);
  await ev(`(() => {
    const el = document.querySelector('.cm-content');
    el.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, ${JSON.stringify('# 标题\n\n' + longLine + '\n\n正文。')});
    return 'ok';
  })()`);
  await sleep(900);

  const after = await measure();
  console.log('灌入 3000 字符长行后：', JSON.stringify(after), '\n');

  after.ws === 'pre-wrap'
    ? pass(`编辑区折行（white-space: ${after.ws}）`)
    : note(`white-space=${after.ws}，长行不会折`);

  (after.flexShrink === '1' || after.flexShrink === '0 1 auto')
    ? pass(`content 允许收缩（flex-shrink: ${after.flexShrink}，min-width: ${after.minWidth}）`)
    : note(`content 的 flex-shrink=${after.flexShrink} —— CM6 默认 0，永不收缩，长行照样撑破`);

  after.overflowX <= 1
    ? pass('编辑区内部无横向溢出')
    : note(`编辑区横向溢出 ${after.overflowX}px（长行把内容撑破了）`);

  after.mainW && after.mainW <= 1300
    ? pass(`编辑区宽度 ${after.mainW}px，未超出窗口`)
    : note(`编辑区宽 ${after.mainW}px，超出窗口 1300px —— flex basis 没有归零`);

  ws.close();
} catch (error) {
  console.error('检查失败：', error.message);
  problems.push(error.message);
} finally {
  killBrowserTree(chrome);
  try { server.close(); } catch { /* 已关闭 */ }
  await sleep(300);
}

console.log(
  problems.length > 0
    ? `\n编辑区布局发现 ${problems.length} 个问题`
    : '\n编辑区布局正常（长行折行 / 不撑破 / 无预览列）',
);
process.exit(problems.length > 0 ? 1 : 0);
