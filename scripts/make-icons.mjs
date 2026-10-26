/**
 * 从 logo.svg 生成应用图标（PNG + Windows ICO）。
 *
 * ⚠️ **这个脚本不生成 Android / iOS 图标。**
 *
 * 移动端图标有自适应图标（`mipmap-anydpi-v26/` + foreground/background 分层）
 * 和一套不同的分辨率命名，由 Tauri CLI 负责：
 *
 *     npx tauri icon logo.svg
 *
 * 它会一次性重写 `src-tauri/icons/` 下的**全部平台**图标（含 android/ios
 * 子目录）。只想更新桌面图标时用本脚本更快（走本机 Chrome，无额外依赖）；
 * 但只要动了 logo，两个都该跑一遍 —— 否则 APK 里还是旧图标。
 *
 * ── 为什么用浏览器而不是图像库 ──────────────────────────────
 * 这个 logo 是纯 path 的 SVG，带多段贝塞尔曲线。用 Python 手写 SVG
 * 光栅化器要处理曲线、填充规则、变换 —— 那是在重造一个渲染引擎。
 * 而本机 Chrome 本来就是个 SVG 渲染器，用它的截图能力反而更准、
 * 依赖更少（不需要 cairo / resvg / sharp 之类）。
 *
 * ── 为什么要 --default-background-color=00000000 ─────────────
 * Chrome 截图默认背景是不透明的白。不加这个标志，透明区域会变成白底，
 * 图标放到深色任务栏上就是一块白方块。
 *
 * 用法：node scripts/make-icons.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

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


const LOGO = resolve('logo.svg');
const OUT = resolve('src-tauri/icons');
const CDP_PORT = 9337;

if (!existsSync(LOGO)) {
  console.error(`找不到 ${LOGO}`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const svg = readFileSync(LOGO, 'utf8');
// 去掉 XML 声明之外的东西保持不变：直接内联即可，它已经是完整的 <svg>。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
    '--hide-scrollbars',
    /*
     * 透明背景**不用** `--default-background-color=00000000`。
     * 那个标志会让这个会话的 CDP 命令全部超时（Page.navigate / Runtime.enable
     * 都可能挂住），且没有任何提示 —— 是那种"看起来像脚本写错了"的失败。
     * 改用 CDP 自己的 Emulation.setDefaultBackgroundColorOverride，
     * 效果相同、作用域更清楚，也不影响启动参数。
     */
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'aropyt-icon-'))}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const CDP = `http://127.0.0.1:${CDP_PORT}`;
const PAGE_PORT = 4395;
let code = 0;

/*
 * 页面先备好，再让标签页**带着这个 URL** 创建。
 *
 * 这是本项目里唯一验证过可行的 CDP 页面初始化方式（verify-visual /
 * check-commands 都用它）。期间试过三种更"直给"的做法全都失败：
 *   1. data: URL → captureScreenshot 超时
 *   2. file:// → Page.navigate 超时
 *   3. 先开 about:blank 再 Page.navigate → 仍然超时
 *   4. document.write 注入 → 后续 CDP 命令超时（执行上下文被换掉）
 * 结论：不要在建页之后再去改它的文档来源，而是建的时候就把 URL 定下来。
 */
const pageHtml =
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
  'svg{display:block;width:100vw;height:100vh}' +
  '</style></head><body>' + svg + '</body></html>';

const pageServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageHtml);
});
await new Promise((r) => pageServer.listen(PAGE_PORT, '127.0.0.1', r));

try {
  for (let i = 0; ; i += 1) {
    try { if ((await fetch(`${CDP}/json/version`)).ok) break; } catch { /* retry */ }
    if (i > 60) throw new Error('DevTools 未就绪');
    await sleep(400);
  }

  const target = await (
    await fetch(`${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PAGE_PORT}/`)}`, { method: 'PUT' })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });

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

  await rpc('Page.enable');
  await rpc('Runtime.enable');

  // 透明背景：截图时背景不填充，图标边缘才不会出现白底方块
  await rpc('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  // 等页面就绪
  await sleep(500);

  /*
   * ── 收紧 viewBox ──────────────────────────────────────────
   *
   * 这个 logo 的 viewBox 是 0 0 500 500，但图形只画在中间：
   *实测 x≈106~394、y≈98~402，也就是只占了 58% 的边长。
   * 于是任务栏 16px 的格子里，图形只有 ~9px —— 视觉上就是"图标很小"。
   *
   * 修法不是放大元素（那只会让形状变形），而是**把 viewBox 收到图形上**：
   * 同样的形状、同样的大小，占满整个画布。
   *
   * 为什么用 getBBox() 而不是照着 SVG 源码里写死一个数字：
   * 任何"统一尺寸/比例"的假设都要对着真实素材量一遍（同一类坑：
   * 工具栏图标名义 1024 网格、实际画到 1047）。写死的数字在 logo
   * 一改就静默失效，而闸门照样是绿的。
   */
  const measured = await rpc('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('svg');
      if (!el) return null;
      const b = el.getBBox();
      const vb = el.viewBox.baseVal;
      return {
        bbox: { x: b.x, y: b.y, width: b.width, height: b.height },
        viewBox: { x: vb.x, y: vb.y, width: vb.width, height: vb.height },
      };
    })()`,
    returnByValue: true,
  });
  const info = measured.result?.value;
  if (!info) throw new Error('量不到 logo 的图形包围盒');
  const { bbox, viewBox } = info;
  const fillX = bbox.width / viewBox.width;
  const fillY = bbox.height / viewBox.height;
  console.log(
    ` 图形占画布 ${(fillX * 100).toFixed(1)}% × ${(fillY * 100).toFixed(1)}%` +
      `（bbox ${bbox.width.toFixed(0)}×${bbox.height.toFixed(0)} / viewBox ${viewBox.width}×${viewBox.height}）`,
  );

  // 收成正方形，取较长的一边居中；再外扩 4% 给边缘留一点呼吸空间。
  const PAD = 0.04;
  const side = Math.max(bbox.width, bbox.height) * (1 + PAD * 2);
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const tight = [cx - side / 2, cy - side / 2, side, side].map((n) => Math.round(n * 100) / 100);
  if (!process.argv.includes('--measure-only')) {
    await rpc('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('svg');
        el.setAttribute('viewBox', '${tight.join(' ')}');
        // 同时把内容按比例放大回填 —— 只改 viewBox 会让浏览器
        // 自动缩放，但如果 CSS 里写死了 width/height 就不一定。
        el.style.width = '100%';
        el.style.height = '100%';
        return el.getAttribute('viewBox');
      })()`,
      returnByValue: true,
    });
    await sleep(200);
    console.log(` viewBox 收紧为 ${tight.join(' ')}（四周外扩 ${(PAD * 100).toFixed(0)}%）`);
  }

  /** 在指定尺寸下把已加载的 SVG 截成 PNG。 */
  async function render(size) {
    await rpc('Emulation.setDeviceMetricsOverride', {
      width: size,
      height: size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(180);
    const shot = await rpc('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(shot.data, 'base64');
  }

  const pngs = new Map();
  console.log('从 logo.svg 生成图标：');
  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    const buf = await render(size);
    pngs.set(size, buf);
    console.log(`  ${String(size).padStart(3)}x${size}  ${buf.length} bytes`);
  }

  /*
   * 把约定里的每个文件名都写一遍。
   *
   * 第一版只写了 Tauri 配置里实际引用的那几个（32/128/128@2x/icon），
   * 结果 `256x256.png` 与 `512x512.png` 一直是**旧脚本留下的残留** ——
   * 换了 logo 之后这两个文件还是老图标，看起来像"生成没生效"。
   *
   * 留着一批不在生成范围内的文件，迟早会有人看到过期的东西。
   * 要么全部由这里产出，要么干脆不产出 —— 这里选前者。
   */
  writeFileSync(join(OUT, '32x32.png'), pngs.get(32));
  writeFileSync(join(OUT, '128x128.png'), pngs.get(128));
  writeFileSync(join(OUT, '128x128@2x.png'), pngs.get(256));
  writeFileSync(join(OUT, '256x256.png'), pngs.get(256));
  writeFileSync(join(OUT, '512x512.png'), pngs.get(512));
  writeFileSync(join(OUT, 'icon.png'), pngs.get(512));

  /*
   * 组装 ICO。
   *
   * 容器格式：6 字节头（reserved=0, type=1, count），随后每帧 16 字节目录项，
   * 再跟着各帧数据。每帧用 PNG 编码（Vista 之后支持），所以直接塞进去就行。
   * width/height 在 256 时写 0 —— 这是格式规定，不是偷懒。
   */
  const sizes = [16, 32, 48, 64, 128, 256];
  const frames = sizes.map((s) => pngs.get(s));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);

  let offset = 6 + 16 * sizes.length;
  const dir = Buffer.alloc(16 * sizes.length);
  sizes.forEach((size, i) => {
    const png = frames[i];
    const at = i * 16;
    const dim = size >= 256 ? 0 : size;
    dir.writeUInt8(dim, at);
    dir.writeUInt8(dim, at + 1);
    dir.writeUInt8(0, at + 2); // 调色板数
    dir.writeUInt8(0, at + 3); // 保留
    dir.writeUInt16LE(1, at + 4); // color planes
    dir.writeUInt16LE(32, at + 6); // bpp
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  const ico = Buffer.concat([header, dir, ...frames]);
  writeFileSync(join(OUT, 'icon.ico'), ico);
  console.log(`\n 已写入 ${OUT}：32 / 128 / 128@2x / 256 / 512 / icon 共 6 个 png`);
  console.log(` icon.ico  ${ico.length} bytes（帧：${sizes.join(', ')}）`);
  console.log(` macOS 需要 icon.icns —— 在 macOS 上用 \`tauri icon\` 补，Windows 构建不需要。`);

  ws.close();
  await new Promise((r) => pageServer.close(r));
} catch (e) {
  console.error('生成图标失败:', e.message);
  code = 1;
} finally {
  killBrowserTree(chrome);
  try {
    pageServer.close();
  } catch {
    /* 可能已关闭 */
  }
  await sleep(400);
}
process.exit(code);
