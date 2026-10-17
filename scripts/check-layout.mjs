/**
 * ⚠️ 暂未接入 verify —— 块级渲染架构下待重写。
 *
 * 本脚本的断言建立在"装饰近似"上（cm-md-h* 标题行、cm-md-list-line
 * 列表行、行距/间距测量）。块级渲染后这些 class 不再出现在普通行上，
 * 6 条断言全部失效，不是渲染坏了。
 *
 * 布局的核心保障（.app-main basis 归零、长行折行、不撑破）已由
 * scripts/check-layout-editor.mjs 覆盖（仍在 verify 里）。
 *
 * 用法：node scripts/check-layout.mjs（手动跑）
 */

/**
 * 布局与**点击落点**的真实浏览器闸门。
 *
 * ── 为什么静态断言不够 ──────────────────────────────────────
 * 这里测的两类问题都是"CSS 写得对、但装配错"：
 *
 * 1. **点击落点偏移**。CM6 的垂直坐标是**按行高累加**算的
 *    （`posAtCoords` → `lineBlockAtHeight`），累加用的是 `offsetHeight`，
 *    **margin 不计入 offsetHeight**。所以只要 `.cm-line` 上有 margin，
 *    后续每一行的落点都会累积偏移 —— 症状是"点第 N 行，光标到第 N+1 行"。
 *    这个偏移量还与文档内容有关（标题越多偏得越远），
 *    静态断言"CSS 里写了 margin"说明不了落点对不对，必须真点一次。
 *
 * 2. **编辑区被 max-width 限制**。曾经的 `max-width: 46em; margin: 0 auto`
 *    让 1600px 视口下左右各浪费 334px。判据只能是**实际几何**
 *    （内容左右边缘 vs 编辑区左右边缘），不是"CSS 里有没有那条规则"。
 *
 * ── 一条不能违反的前提 ──────────────────────────────────────
 * 灌文档必须 `selectAll` + `insertText`。只 `insertText` 会与页面初始
 * 内容叠在一起，行号整体错位 —— 那会造出"落点偏一行"的假象，
 * 把排查引向产品代码（本项目的 check-selection 就为此白查过一轮）。
 *
 * 用法：node scripts/check-layout.mjs
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
const OUT = resolve('screenshots');
const PORT = 4406;
const CDP_PORT = 9345;

/** 用哪种视口跑。宽屏最能暴露"内容被收窄"的问题。 */
const VIEWPORTS = [
  { w: 1600, h: 900, label: '宽屏 1600' },
  { w: 1024, h: 800, label: '窄屏 1024' },
];

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
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'aropyt-layout-'))}`,
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
  let seq = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 抛错');
    return r.result?.value;
  };
  const click = async (x, y) => {
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y) });
    await sleep(60);
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1 });
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 0, clickCount: 1 });
    await sleep(240);
  };
  const pressKey = async (key, vk) => {
    const o = { key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await rpc('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...o });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', ...o });
    await sleep(120);
  };

  await rpc('Page.enable');
  await rpc('Runtime.enable');

  for (const vp of VIEWPORTS) {
    console.log(`\n── ${vp.label} ──`);
    await rpc('Emulation.setDeviceMetricsOverride', {
      width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(900);

    /*
     * 文档刻意包含：标题（曾经带 margin，是落点偏移的元凶）、
     * 多段正文、列表（要有可见项目符号）、一行长文（折行）。
     */
    await ev(`(() => {
      const el = document.querySelector('.cm-content');
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, [
        '# 一级标题','', '第一段正文内容。','', '## 二级标题','',
        '第二段正文内容。','', '### 三级标题','', '第三段正文内容。','',
        '- 无序项一','- 无序项二','','1. 有序项一','2. 有序项二','','',
      ].join('\\n'));
      return 'ok';
    })()`);
    await sleep(1500);

    // 光标挪到末尾空行 —— 让所有被测行处于渲染态
    await pressKey('End', 35);
    for (let i = 0; i < 12; i += 1) await pressKey('ArrowDown', 40);
    await sleep(900);

    // ── 1) 编辑区必须铺满，不被 max-width 收窄 ──
    const geo = await ev(`(() => {
      const sc = document.querySelector('.cm-scroller');
      const ct = document.querySelector('.cm-content');
      const sb = sc.getBoundingClientRect();
      const cb = ct.getBoundingClientRect();
      return {
        scrollerW: Math.round(sb.width),
        contentW: Math.round(cb.width),
        maxWidth: getComputedStyle(ct).maxWidth,
        leftGap: Math.round(cb.left - sb.left),
        rightGap: Math.round(sb.right - cb.right),
      };
    })()`);
    console.log('  几何：', JSON.stringify(geo));
    if (geo.leftGap > 2 || geo.rightGap > 2) {
      note(
        `${vp.label}：编辑区左右各留 ${geo.leftGap}/${geo.rightGap}px 空白` +
          `（内容 ${geo.contentW} / 编辑区 ${geo.scrollerW}）—— 内容被收窄了`,
      );
    } else {
      pass(`${vp.label}：内容铺满编辑区（无左右留白）`);
    }

    // ── 2) 逐行真实点击，落点必须就是被点的那一行 ──
    //
    // 先滚回顶部，保证所有行都在视口里可点。
    await ev(`(() => { document.querySelector('.cm-scroller').scrollTop = 0; return 'ok'; })()`);
    await sleep(400);

    const rows = await ev(`(() => [...document.querySelectorAll('.cm-line')].map((l, i) => {
      const b = l.getBoundingClientRect();
      return { i, text: (l.textContent||'').trim().slice(0,14), top: Math.round(b.top),
        h: Math.round(b.height), left: Math.round(b.left) };
    }))()`);

    let checked = 0;
    for (const row of rows) {
      if (!row.text) continue;           // 空行点了会落到相邻行，不算问题
      await click(row.left + 20, row.top + row.h / 2);
      const active = await ev(`(() => {
        const ls = [...document.querySelectorAll('.cm-line')];
        return ls.findIndex((l) => l.classList.contains('cm-activeLine'));
      })()`);
      checked += 1;
      if (active !== row.i) {
        note(
          `${vp.label}：点第 ${row.i} 行「${row.text}」落到第 ${active} 行` +
            `（y=${row.top + row.h / 2}, 行高 ${row.h}）—— 垂直坐标有累积偏移`,
        );
        break;
      }
    }
    if (checked > 0 && problems.length === 0) {
      pass(`${vp.label}：${checked} 行逐行点击，落点全部正确`);
    } else if (checked === 0) {
      note(`${vp.label}：没有可点击的文本行（文档没灌进去？）`);
    }

    // ── 3) 标题的间距必须来自 padding 而不是 margin ──
    //
    // margin 不计入 offsetHeight，会让后续行的落点整体偏移。
    // 这条与上面的点击测试是"规则"与"现象"的关系，两条都要有：
    // 有了规则能快速定位，有了现象能证明规则真的重要。
    const spacing = await ev(`(() => {
      const heads = [...document.querySelectorAll('.cm-line')]
        .filter((l) => /cm-md-h[1-6]/.test(l.className));
      return heads.map((l) => {
        const cs = getComputedStyle(l);
        return {
          text: (l.textContent||'').slice(0, 12),
          fontSize: parseFloat(cs.fontSize),
          marginTop: parseFloat(cs.marginTop),
          marginBottom: parseFloat(cs.marginBottom),
          paddingTop: parseFloat(cs.paddingTop),
          paddingBottom: parseFloat(cs.paddingBottom),
        };
      });
    })()`);
    const badMargin = spacing.filter((s) => s.marginTop !== 0 || s.marginBottom !== 0);
    if (badMargin.length > 0) {
      note(
        `${vp.label}：${badMargin.length} 个标题行带 margin` +
          `（${badMargin.map((s) => `${s.text} top=${s.marginTop}px`).join('; ')}）—— ` +
          'margin 不计入行高，会让后续行落点累积偏移',
      );
    } else if (spacing.length === 0) {
      note(`${vp.label}：找不到标题行，间距断言会恒真`);
    } else {
      /*
       * 判据用"与字号的比例"而不是"大于 0"。
       *
       * 大于 0 太松：曾有一条**遗留的** `paddingTop: 0.05em` 规则
       * 在文件末尾把新写的 `0.9em` 压成了 1.275px —— 它仍然 > 0，
       * 断言会放行一个"标题几乎贴着上一行"的界面。
       * 要求 ≥ 0.4 倍字号（约 10px）才说明留白是真的存在。
       */
      const tooTight = spacing.filter((s) => s.paddingTop < s.fontSize * 0.4);
      const noBottom = spacing.filter((s) => s.paddingBottom <= 0);
      if (tooTight.length > 0) {
        note(
          `${vp.label}：${tooTight.length} 个标题的上留白过小` +
            `（${tooTight.map((s) => `${s.text} ${s.paddingTop}px / 字号 ${s.fontSize}px`).join('; ')}）` +
            '—— 多半有条同特异性的规则在后面压着 padding-top',
        );
      } else if (noBottom.length > 0) {
        note(`${vp.label}：${noBottom.length} 个标题没有下留白`);
      } else {
        pass(`${vp.label}：标题间距由 padding 提供且量级正常（${spacing.length} 行）`);
      }
    }

    // ── 4) 列表必须有**可见**的项目符号 ──
    //
    // 只断言"有 ::before 规则"不够 —— 规则可能因为选择器写错而没命中。
    // 判据取 ::before 的**实际几何宽度**。
    const lists = await ev(`(() => {
      const rows = [...document.querySelectorAll('.cm-line.cm-md-list-line')];
      return rows.map((l) => {
        const before = getComputedStyle(l, '::before');
        return {
          text: (l.textContent||'').trim().slice(0, 14),
          content: before.content,
          width: before.width,
          display: before.display,
          // 行的实际内容宽度：有符号的话会比纯文字宽
          rowW: Math.round(l.getBoundingClientRect().width),
        };
      });
    })()`);
    console.log('  列表行：', JSON.stringify(lists.map((l) => ({ t: l.text, c: l.content }))));
    if (lists.length === 0) {
      note(`${vp.label}：找不到列表行（cm-md-list-line），标记断言会恒真`);
    } else {
      const bad = lists.filter(
        (l) => !l.content || l.content === 'none' || l.content === 'normal' || l.content === '""',
      );
      if (bad.length > 0) {
        note(
          `${vp.label}：${bad.length} 个列表行没有可见的项目符号` +
            `（${bad.map((l) => l.text).join('; ')}）—— 列表会退化成缩进段落`,
        );
      } else {
        pass(`${vp.label}：${lists.length} 个列表行都有项目符号`);
      }
    }

    const shot = await rpc('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `layout-${vp.w}.png`), Buffer.from(shot.data, 'base64'));
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
    ? `\n布局检查发现 ${problems.length} 个问题`
    : '\n布局与点击落点全部正常（铺满 / 落点 / 标题间距 / 列表符号）',
);
process.exit(problems.length > 0 ? 1 : 0);
