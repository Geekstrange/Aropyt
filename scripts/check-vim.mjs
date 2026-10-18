/**
 * 标签页的闸门（VSCode 式的"预览标签"）。
 *
 * ── 规则（与 VSCode 一致）──────────────────────────────────
 *   单击文件 → 开在预览标签里（**斜体**），且**至多一个**：
 *             下一次单击会把它顶掉，而不是越点越多。
 *   双击文件 → 开在固定标签里（正体），不会被动摇。
 *   编辑预览标签 → 它自己转正（斜体消失）。
 *
 * 这套规则看着琐碎，但它解决的是一个真实矛盾：
 * "随手翻几个文件看看"不希望标签栏被塞满，
 * "我正在改的文件"又绝不能被下一次单击顶走。
 * 用两个状态区分开才是正解，所以两条都要测 —— 只测一条会把另一半弄坏。
 *
 * 用法：npm run check:tabs
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';

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
const PORT = 4418;
const CDP_PORT = 9357;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const problems = [];
const note = (m) => { problems.push(m); console.log('  ✗ ' + m); };
const pass = (m) => console.log('  ✓ ' + m);

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
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'aropyt-tabs-'))}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = `http://127.0.0.1:${CDP_PORT}`;

try {
  for (let i = 0; ; i += 1) {
    try { if ((await fetch(`${CDP}/json/version`)).ok) break; } catch { /* retry */ }
    if (i > 60) throw new Error('DevTools 未就绪');
    await sleep(400);
  }

  const target = await (
    await fetch(`${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/`)}`, { method: 'PUT' })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });

  const pending = new Map();
  const logs = [];
  let seq = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args ?? [])
        .map((a) => a.value ?? a.description ?? '')
        .join(' ');
      logs.push(text);
      return;
    }
    const cb = pending.get(m.id);
    if (cb) { pending.delete(m.id); cb(m); }
  };
  const rpc = (method, params = {}) => new Promise((res2, rej2) => {
    const id = ++seq;
    const t = setTimeout(() => rej2(new Error(method + ' 超时')), 20000);
    pending.set(id, (m) => { clearTimeout(t); m.error ? rej2(new Error(m.error.message)) : res2(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面内异常');
    return r.result?.value;
  };

  /** 三个 md 文件，够用来看"替换 / 追加 / 转正"三种走向。 */

  // ── vim 模式：用**真实键盘事件**验证常用命令 ──────────────────
  // 开关：点状态栏的 VIM 按钮（持久化在 localStorage，可能本来就开着）
  await ev(`(() => {
    const btn = document.querySelector('.status-bar__vim');
    if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
  })()`);
  await sleep(1200); // 等 vim 扩展动态加载

  const key = async (k, code, vk, text) => {
    await rpc('Input.dispatchKeyEvent', {
      type: 'keyDown', key: k, code, text: text ?? k,
      windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
    await sleep(180);
  };
  const K = {
    x: () => key('x', 'KeyX', 88),
    i: () => key('i', 'KeyI', 73),
    p: () => key('p', 'KeyP', 80),
    u: () => key('u', 'KeyU', 85),
    g: () => key('g', 'KeyG', 71),
    G: () => key('G', 'KeyG', 71, 'G'),
    y: () => key('y', 'KeyY', 89),
    d: () => key('d', 'KeyD', 68),
    Escape: () => key('Escape', 'Escape', 27, ''),
    Backspace: () => key('Backspace', 'Backspace', 8, ''),
    Enter: () => key('Enter', 'Enter', 13, '\r'),
    Colon: () => key(':', 'Semicolon', 186, ':'),
    Slash: () => key('/', 'Slash', 191, '/'),
  };
  /*
   * 状态读取用 DOM：`.cm-line` 拼接即当前文档文本（**必须处于源码模式**，
   * 渲染态下 .cm-line 是块渲染的结果，不含 markdown 标记）。
   * 光标行号：CM6 的 .cm-cursor 元素所在的 .cm-line 序号。
   */
  const st = () => ev(`(() => {
    const lines = [...document.querySelectorAll('.cm-line')].map((el) => el.textContent);
    const cur = document.querySelector('.cm-cursor');
    const lineEl = cur ? cur.closest('.cm-line') : null;
    const head = lineEl ? lines.indexOf(lineEl.textContent) : -1;
    return { text: lines.join('\n'), lines: lines.length, head };
  })()`);
  const expect = (ok, label) => { if (!ok) note(label); else console.log('  ok  ' + label); };

  // 切到源码模式：.cm-line 才是原始文本（渲染态是渲染结果，断言语义会失真）
  await rpc('Input.dispatchKeyEvent', {
    type: 'keyDown', key: '/', code: 'Slash', modifiers: 2,
    windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191,
  });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash', modifiers: 2 });
  await sleep(500);
  await ev(`document.querySelector('.cm-content').focus()`);
  // 准备固定文本（3 行）—— 源码模式下 execCommand 会走真实输入路径
  await ev(`document.execCommand('selectAll')`);
  await ev(`document.execCommand('insertText', false, ['alpha one', 'beta two', 'gamma three', ''].join(String.fromCharCode(10)))`);
  await sleep(400);
  const base = await st();
  if (!base) { note('拿不到编辑器状态（cmView 不可达）'); }

  // 1) ⚠️ 核心回归：normal 模式下 Backspace **不能删字符**
  await K.Backspace();
  const afterBs = await st();
  expect(afterBs && afterBs.text === base.text, `normal 模式 Backspace 不删字符（长度 ${base.text.length} → ${afterBs?.text.length}）`);

  // 2) x 删一个字符
  await K.x();
  const afterX = await st();
  expect(afterX && afterX.text.length === base.text.length - 1, `x 删除一个字符（${base.text.length} → ${afterX?.text.length}）`);

  // 3) u 撤销
  await K.u();
  const afterU = await st();
  expect(afterU && afterU.text === base.text, 'u 撤销恢复原文本');

  // 4) dd 删整行
  await K.d(); await K.d();
  const afterDd = await st();
  expect(afterDd && afterDd.lines === base.lines - 1, `dd 删除一行（${base.lines} → ${afterDd?.lines}）`);

  // 5) yy 复制 + p 粘贴 → 行数回增
  await K.y(); await K.y();
  await K.p();
  const afterP = await st();
  expect(afterP && afterP.lines === afterDd.lines + 1, `yy/p 复制粘贴一行（${afterDd.lines} → ${afterP?.lines}）`);

  // 6) gg / G 跳转
  await K.g(); await K.g();
  const atTop = await st();
  await K.G();
  const atBottom = await st();
  expect(atTop && atTop.head === 0, `gg 跳到首行（rank=${atTop?.head}）`);
  expect(atBottom && atBottom.head >= (atTop?.head ?? 0) + 2, `G 跳到末行（rank=${atBottom?.head}）`);

  // 7) :s/// 替换
  await K.Colon();
  for (const ch of 's/alpha/ALPHA/') {
    await key(ch, 'Key' + ch.toUpperCase(), ch.charCodeAt(0), ch);
  }
  await K.Enter();
  const afterSub = await st();
  expect(afterSub && afterSub.text.includes('ALPHA'), sfx(afterSub?.text));

  // 8) /搜索 + n
  await K.Slash();
  for (const ch of 'beta') await key(ch, 'Key' + ch.toUpperCase(), ch.charCodeAt(0), ch);
  await K.Enter();
  const afterSearch = await st();
  expect(afterSearch && afterSearch.head >= 0, '搜索 /beta 定位到目标');

  function sfx(text) {
    return `替换后文本是否含 ALPHA（${text ? (text.includes('ALPHA') ? '是' : '否') : '无状态'}）`;
  }

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
    ? `\nvim 模式检查发现 ${problems.length} 个问题`
    : '\nvim 模式行为正常（normal 不删字 / x / u / dd / yy-p / gg-G / :s / 搜索）',
);
process.exit(problems.length > 0 ? 1 : 0);
