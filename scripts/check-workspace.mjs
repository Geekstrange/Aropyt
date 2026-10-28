/**
 * 验证「从工作区移除目录」与「关闭工作区」两条链路。
 *
 * 为什么要单独一个闸门：这两件事都只改**界面状态**（移除不碰磁盘、
 * 关闭不动文件），所以任何"看起来生效了"的假象都很容易骗过肉眼 ——
 * 比如移除后树确实少了一行，但重新打开应用又全回来了（memento 写错），
 * 或者移除只藏了自己那一行、子树还挂在下面（过滤只做了一层）。
 * 这些只有跑一遍真实 DOM 才现形。
 *
 * 手法与 check-commands 相同：提前注入 `__TAURI_INTERNALS__` 桩，
 * 让 capability 层认为自己在原生外壳里，走的是真实代码路径。
 *
 * 用法：npm run check:workspace
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';

const killBrowserTree = (child) => {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
};

const ROOT = resolve('apps/web/dist');
const PORT = 4397;
const CDP_PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEMO_ROOT = 'E:\\dev\\Aropyt-demo';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
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

const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'aropyt-ws-'))}`,
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const CDP = `http://127.0.0.1:${CDP_PORT}`;
const problems = [];
const ok = (label) => console.log('  OK   ' + label);
const bad = (label) => {
  problems.push(label);
  console.log('  FAIL ' + label);
};

try {
  for (let i = 0; ; i += 1) {
    try { if ((await fetch(`${CDP}/json/version`)).ok) break; } catch { /* retry */ }
    if (i > 60) throw new Error('DevTools 未就绪');
    await sleep(400);
  }

  const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
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
      logs.push('[EXCEPTION] ' + (m.params.exceptionDetails?.exception?.description ?? '').split('\n')[0]);
    }
    const cb = pending.get(m.id);
    if (cb) { pending.delete(m.id); cb(m); }
  };
  const rpc = (method, params = {}) => new Promise((res2, rej) => {
    const id = ++seq;
    const t = setTimeout(() => rej(new Error(method + ' 超时')), 20000);
    pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res2(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) =>
    (await rpc('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))
      .result?.value;

  const STUB = `
    window.__TAURI_INTERNALS__ = {
      invoke: function (command, args) {
        if (command === 'pick_folder') return Promise.resolve(${JSON.stringify(DEMO_ROOT)});
        if (command === 'set_workspace') return Promise.resolve(null);
        if (command === 'workspace_list') {
          var dir = (args && args.args && args.args.path) || '';
          if (dir === '') {
            return Promise.resolve([
              { path: 'guide.md', name: 'guide.md', kind: 'file', size: 12, mtime: 1700000000000 },
              { path: 'notes', name: 'notes', kind: 'directory', size: 0, mtime: 1700000000000 },
              { path: 'readme.txt', name: 'readme.txt', kind: 'file', size: 5, mtime: 1700000000000 },
            ]);
          }
          if (dir === 'notes') {
            return Promise.resolve([
              { path: 'notes/todo.md', name: 'todo.md', kind: 'file', size: 7, mtime: 1700000000000 },
            ]);
          }
          return Promise.resolve([]);
        }
        if (command === 'workspace_read') return Promise.resolve('');
        if (command === 'workspace_write') return Promise.resolve(null);
        return Promise.reject(new Error('桩未实现的命令：' + command));
      },
    };
  `;
  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await rpc('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(4500);

  const openFolder = async () => {
    await ev(`(() => {
      const b = [...document.querySelectorAll('.toolbar button')]
        .find((x) => (x.getAttribute('aria-label') || x.title || '') === '打开文件夹…');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(1800);
  };

  const tree = () => ev(`(() => {
    const header = document.querySelector('.explorer-header__name');
    return {
      header: header ? header.textContent : null,
      hasCloseButton: !!document.querySelector('.explorer-header__close'),
      rows: [...document.querySelectorAll('.tree-item')].map((r) => ({
        label: r.querySelector('.tree-item__label')?.textContent ?? '',
        hasAction: !!r.querySelector('.tree-item__action'),
      })),
    };
  })()`);

  const clickRowAction = (label) => ev(`(() => {
    const row = [...document.querySelectorAll('.tree-item')]
      .find((r) => (r.querySelector('.tree-item__label')?.textContent ?? '') === ${JSON.stringify(label)});
    if (!row) return 'NO_ROW';
    const action = row.querySelector('.tree-item__action');
    if (!action) return 'NO_ACTION';
    action.click();
    return 'clicked';
  })()`);

  console.log('\n=== 打开工作区 ===');
  await openFolder();
  const first = await tree();
  console.log('  抬头：', JSON.stringify(first.header), '关闭按钮：', first.hasCloseButton);
  if (first.header === 'Aropyt-demo') ok('文件树抬头显示工作区名'); else bad('文件树抬头没有显示工作区名');
  if (first.hasCloseButton) ok('抬头带「关闭工作区」按钮'); else bad('抬头缺少关闭按钮');
  if (!first.rows.some((r) => r.label === 'notes' && r.hasAction)) bad('目录行没有「从工作区移除」按钮');
  else ok('目录行带移除按钮');

  /*
   * 截一张"动作可见"的图。
   *
   * 那两个 × 平时是 hover 态才露出的，而无头浏览器没有指针 —— 不强制
   * 显形就永远拍不到，也就无法用肉眼确认它有没有压住文件名。
   */
  await ev(`(() => {
    const style = document.createElement('style');
    style.textContent = '.tree-item__action { visibility: visible !important; }';
    document.head.append(style);
    return 'ok';
  })()`);
  {
    const shot = await rpc('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync('screenshots', { recursive: true });
    writeFileSync('screenshots/workspace-tree.png', Buffer.from(shot.data, 'base64'));
    console.log('  已保存 screenshots/workspace-tree.png');
  }

  console.log('\n=== 移除 notes ===');
  const hit = await clickRowAction('notes');
  if (hit !== 'clicked') bad('没能点到 notes 的移除按钮：' + hit);
  await sleep(1200);
  const second = await tree();
  console.log('  剩余行：', JSON.stringify(second.rows.map((r) => r.label)));
  if (second.rows.some((r) => r.label === 'notes')) bad('移除后 notes 这一行还在');
  else ok('移除后 notes 这一行消失');
  if (second.rows.some((r) => r.label === 'todo.md')) bad('移除只藏了父行，子树 todo.md 仍显示');
  else ok('子树一并隐藏（不是只藏一层）');
  if (second.rows.some((r) => r.label === 'guide.md')) ok('其它文件不受影响');
  else bad('移除操作误伤了其它文件');

  console.log('\n=== 重新加载后仍然生效 ===');
  await rpc('Page.reload');
  await sleep(4500);
  await openFolder();
  const third = await tree();
  console.log('  剩余行：', JSON.stringify(third.rows.map((r) => r.label)));
  if (third.rows.some((r) => r.label === 'notes')) bad('重新加载后 notes 又回来了（memento 没写进去）');
  else ok('移除结果被持久化');

  console.log('\n=== 命令面板恢复 ===');
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', {
    code: 'KeyP', key: 'P', ctrlKey: true, shiftKey: true, bubbles: true,
  }))`);
  await sleep(800);
  const palette = await ev(`(() => {
    const items = [...document.querySelectorAll('.palette__item')].map((i) => i.textContent ?? '');
    return items;
  })()`);
  console.log('  面板条目数：', Array.isArray(palette) ? palette.length : palette);
  const clicked = await ev(`(() => {
    const item = [...document.querySelectorAll('.palette__item')]
      .find((i) => (i.textContent ?? '').includes('恢复已移除的目录'));
    if (!item) return 'NOT_FOUND';
    item.click();
    return 'clicked';
  })()`);
  await sleep(1500);
  console.log('  点击结果：', clicked);
  if (clicked !== 'clicked') bad('命令面板里找不到「恢复已移除的目录」');
  const fourth = await tree();
  console.log('  剩余行：', JSON.stringify(fourth.rows.map((r) => r.label)));
  if (fourth.rows.some((r) => r.label === 'notes')) ok('恢复后 notes 回到文件树');
  else bad('恢复命令没有让 notes 回到文件树');

  console.log('\n=== 关闭工作区 ===');
  const closed = await ev(`(() => {
    const b = document.querySelector('.explorer-header__close');
    if (!b) return 'NO_BUTTON';
    b.click();
    return 'clicked';
  })()`);
  await sleep(1500);
  const afterClose = await tree();
  console.log('  关闭结果：', closed, '抬头：', JSON.stringify(afterClose.header));
  if (afterClose.header === null) ok('关闭后抬头消失，回到"未打开工作区"');
  else bad('关闭后仍显示工作区抬头');
  const emptyText = await ev(`document.querySelector('.view-empty')?.textContent ?? null`);
  console.log('  空状态：', JSON.stringify(emptyText));
  if (typeof emptyText === 'string' && emptyText.includes('尚未打开工作区')) ok('回到空状态并给出引导');
  else bad('关闭后没有回到空状态');

  if (logs.some((l) => l.includes('[EXCEPTION]'))) {
    bad('控制台出现未捕获异常：' + logs.filter((l) => l.includes('[EXCEPTION]'))[0]);
  } else {
    ok('控制台无未捕获异常');
  }

  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('screenshots', { recursive: true });
  writeFileSync('screenshots/workspace-close.png', Buffer.from(shot.data, 'base64'));
  console.log('\n已保存 screenshots/workspace-close.png');

  console.log('\n=== 判定 ===');
  if (problems.length === 0) {
    console.log('「移除目录」与「关闭工作区」两条链路全部走通');
  } else {
    console.log(problems.map((p) => '  - ' + p).join('\n'));
    process.exitCode = 1;
  }
  /*
   * 必须显式关掉 WebSocket。
   *
   * 只有它会让事件循环一直活着：Chrome 已被杀、HTTP server 已关，
   * 但那条处在 OPEN 状态的连接仍然挂着 —— 进程于是"跑完了却永不退出"，
   * 在 CI 里表现为这一步一直占着 job 直到超时（本地实测 2 分钟还没退）。
   */
  ws.close();
} catch (error) {
  console.error('闸门自身出错：', error);
  process.exitCode = 1;
} finally {
  killBrowserTree(chrome);
  server.close();
}

// 兜底：Chrome 子进程即使按树杀掉，CDP 的 fetch keepalive 也可能拖住事件循环
process.exit(problems.length > 0 ? 1 : 0);
