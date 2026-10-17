/**
 * 用本机 Chrome 的 CDP 抓页面截图。
 *
 * ── 为什么不用 agent-browser ──────────────────────────────
 * 它自带那份 Chromium 在本机起不来（Chrome exited early /
 * 不写 DevToolsActivePort），而本机已装 Chrome 加 `--no-sandbox`
 * 跑无头没问题。直接说 CDP 依赖更少。
 *
 * ── 为什么 Chrome 必须由本脚本自己拉 ──────────────────────
 * 曾试图先单独后台启动 Chrome、再另起进程连它 —— 失败：
 * 后台子进程不跨工具调用存活，第二次调用时 Chrome 主进程已被回收
 * （端口只剩 TIME_WAIT，没有 LISTENING）。
 * 所以 Chrome 必须是本进程的子进程，生命周期绑在一起。
 *
 * 用法：
 *   node scripts/cdp-shot.mjs <url> <输出png> [等待ms] [注入JS]
 */

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep, dirname, basename } from 'node:path';

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


const [, , urlArg, outPath, waitMsArg, inject] = process.argv;
if (!urlArg || !outPath) {
  console.error('用法: node scripts/cdp-shot.mjs <url|serve:目录> <输出png> [等待ms] [注入JS]');
  process.exit(2);
}
const waitMs = Number(waitMsArg ?? 3500);

/*
 * 内置静态服务。
 *
 * 为什么必须同一个进程：曾用 `vite preview &` 单独起服务，
 * 结果工具调用一结束服务就被回收 —— 截图时全是 ERR_CONNECTION_REFUSED。
 * 后台子进程不跨调用存活，所以服务必须是本进程的孩子。
 */
let server = null;
let url = urlArg;
if (urlArg.startsWith('serve:')) {
  // 必须 resolve 成绝对路径：Windows 上 join 产出的分隔符是反斜杠，
  // 而命令行传进来的 root 是正斜杠 —— 直接 startsWith 比较会永远不成立，
  // 表现为整个目录 403（排查时很容易误以为是权限问题）。
  // 目标可以是目录（取 index.html），也可以是单个 html 文件。
  // 之前只支持目录，于是 preview.html 这种不叫 index 的页面根本没法截。
  const target = resolve(urlArg.slice('serve:'.length));
  const singleFile = existsSync(target) && statSync(target).isFile();
  const root = singleFile ? dirname(target) : target;
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  server = createServer((req, res) => {
    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
    // 统一转成 POSIX 风格再拼，避免正/反斜杠混用
    const relative = pathname.split('/').filter((seg) => seg !== '' && seg !== '.' && seg !== '..');
    let filePath = join(root, ...relative);

    // 路径穿越防护：解析后的绝对路径必须仍在根目录内。
    // 用 resolve + sep 比较，而不是字符串前缀 —— 后者会被
    // "../dist-evil" 这类同前缀目录绕过。
    const resolved = resolve(filePath);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }

    /*
     * 先把内容读出来，再写响应头。
     *
     * 原来是 writeHead(200) → readFileSync → catch 里再 writeHead(404)：
     * 服务一个**没有 index.html 的目录**时，200 的头已经发出去了、
     * 读文件才失败，于是 catch 里的 writeHead(404) 抛
     * ERR_HTTP_HEADERS_SENT —— 不是返回 404，是**把整个进程带走**，
     * 而调用方只看到一段 Node 崩溃栈。读在前、写在后，写头就只会发生一次。
     */
    let body = null;
    let served = filePath;
    try {
      if (statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
      body = readFileSync(filePath);
      served = filePath;
    } catch {
      // 回退：找不到就交 index.html（无它则 404）
      const fallback = join(root, 'index.html');
      try {
        body = readFileSync(fallback);
        served = fallback;
      } catch {
        body = null;
      }
    }

    if (body === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(served)] ?? 'application/octet-stream' });
    res.end(body);
  });
  await new Promise((r) => server.listen(4399, '127.0.0.1', r));
  url = `http://127.0.0.1:4399/${singleFile ? basename(target) : ''}`;
  console.log(`静态服务已启动：${root} -> ${url}`);
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome / Edge');
  process.exit(2);
}

const PORT = 9333;
// 必须写 127.0.0.1：Node 的 fetch 会把 localhost 优先解析成 ::1，
// 而调试端口默认只监听 IPv4，表现为 ECONNREFUSED（很难看出是这个原因）。
const CDP = `http://127.0.0.1:${PORT}`;

const profileDir = mkdtempSync(join(tmpdir(), 'aropyt-cdp-'));

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1440,900',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 DevTools 端口起来。比固定 sleep 可靠，慢机器上不会假失败。 */
async function waitForCdp(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${CDP}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  throw new Error('DevTools 端口未就绪');
}

let exitCode = 0;
try {
  await waitForCdp();

  // 开新标签页（新版 Chrome 要求 PUT；GET 在部分版本上直接 405）
  let target;
  try {
    const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(String(res.status));
    target = await res.json();
  } catch {
    const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`);
    target = await res.json();
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('WebSocket 连接失败'));
  });

  const pending = new Map();
  let seq = 0;
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const cb = pending.get(msg.id);
    if (cb) {
      pending.delete(msg.id);
      cb(msg);
    }
  };

  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 30000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await sleep(waitMs);

  if (inject) {
    const result = await rpc('Runtime.evaluate', {
      expression: inject,
      awaitPromise: true,
      returnByValue: true,
    });
    const value = result.result?.value;
    console.log('注入结果:', JSON.stringify(value ?? result.result?.description ?? null));
    await sleep(1500);
  }

  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log(`已保存 ${outPath}`);

  ws.close();
} catch (error) {
  console.error('截图失败:', error.message);
  exitCode = 1;
} finally {
  killBrowserTree(chrome);
  if (server) server.close();
  // 给 Chrome 一点收尾时间，避免留下孤儿进程占端口
  await sleep(600);
}

process.exit(exitCode);
