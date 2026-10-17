/**
 * ⚠️ 暂未接入 verify —— 块级渲染架构下的选区验收待重写。
 *
 * 本脚本的全部断言建立在"装饰近似"的假设上：标记行是文本、
 * 折行坐标可测、围栏行存在、选区高亮层挂在行上。块级渲染
 * （markdown-it 整块替换为 HTML widget）之后，这些测试对象
 * 大部分不存在了 —— 5 条断言全部失效，而不是"渲染坏了"。
 *
 * 新架构下选区行为的验收要点（待实现）：
 *   - 光标块内：文本可选、选区高亮正常（CM6 原生）
 *   - 跨块选区：CM6 对 replace widget 的原生行为
 *   - 点击渲染块 → 光标落块首 → 块切回源码（已实现，可测）
 *
 * 用法：node scripts/check-selection.mjs（手动跑，不在 verify 里）
 */

/**
 * 验证渲染态的**文字选择**（拖选 / 双击 / 单击落点）。
 *
 * ── 为什么必须单独一个脚本 ──────────────────────────────────
 * `cdp-shot` 只能注入 JS，而选区必须用**真实鼠标拖选 + 真实绘制**才测得出来：
 * 合成事件不产生浏览器原生选区，选区矩形对不对也只能靠读 DOM。
 *
 * ── 三条踩过的坑（每条都让闸门恒红或恒绿过）───────────────
 *
 * 1. **光标必须在被测行之外**。渲染态的规则是"光标在哪行哪行标记显形"，
 *    光标停在被测行上等于在测源码态 —— 而 bug 只发生在渲染态。
 *    不挪光标，这条闸门测的是另一条代码路径。
 *
 * 2. **命中坐标必须用"可见片段"的实际矩形**，不能用"行左 + 固定偏移"。
 *    渲染态下各片段的宽度取决于标记被藏了多少，固定偏移落在哪一段
 *    完全不可预测 —— 从行内空白处起手会选到空串，
 *    现象与"拖选坏了"一模一样，却根本是探针自己的问题。
 *
 * 3. **textContent 不反映 CSS**。标记被 `display: none` 藏住后，
 *    `line.textContent` 仍含 `**`。用它判断"渲染态生效没有"会得出
 *    完全相反的结论 —— 要看**可见片段**（祖先无 display:none）。
 *
 * 用法：node scripts/check-selection.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
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
const PORT = 4402;
const CDP_PORT = 9341;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const problems = [];
const note = (p) => {
  problems.push(p);
  console.log('  ✗ ' + p);
};
const pass = (m) => console.log('  ✓ ' + m);

/**
 * 比较两个 CSS 颜色是否等价。
 *
 * 必须比数值而不是比字符串：同一颜色在 CSS 变量原文里可能是
 * `rgba(43, 111, 212, .18)`，计算值却是 `rgba(43, 111, 212, 0.18)`。
 * 直接比字符串会让"选区用了色板"这条断言恒红 —— 而恒红的断言
 * 等于没有断言（跑久了就没人看了）。
 */
function sameColor(a, b) {
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c ?? '');
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return parts.length >= 3
      ? [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1]
      : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a === b;
  return pa.every((v, i) => Math.abs(v - pb[i]) < 0.01);
}

const server = createServer((req, res) => {
  const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = join(ROOT, rel);
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'aropyt-sel-'))}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = `http://127.0.0.1:${CDP_PORT}`;

try {
  for (let i = 0; ; i += 1) {
    try {
      if ((await fetch(`${CDP}/json/version`)).ok) break;
    } catch {
      /* retry */
    }
    if (i > 60) throw new Error('DevTools 未就绪');
    await sleep(400);
  }

  const target = await (
    await fetch(`${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/`)}`, { method: 'PUT' })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws'));
  });

  const pending = new Map();
  let seq = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const cb = pending.get(m.id);
    if (cb) {
      pending.delete(m.id);
      cb(m);
    }
  };
  const rpc = (method, params = {}) =>
    new Promise((res2, rej2) => {
      const id = ++seq;
      const t = setTimeout(() => rej2(new Error(method + ' 超时')), 20000);
      pending.set(id, (m) => {
        clearTimeout(t);
        m.error ? rej2(new Error(m.error.message)) : res2(m.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await rpc('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 抛错');
    }
    return r.result?.value;
  };
  const pressKey = async (key, vk) => {
    const o = { key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await rpc('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...o });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', ...o });
    await sleep(140);
  };
  const dragSelect = async (from, to) => {
    /*
     * 先移到起点再按。
     *
     * 原先这里先发一次 `mouseMoved({x:0,y:0})` 当"重置"，
     * 结果鼠标从 (0,0) 横扫到目标行的途中会触发 CM6 的
     * hover / 光标跟随 —— 实测它会让随后的落点偏一整行。
     * 直接落在起点才是真实用户路径。
     */
    await rpc('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from.x), y: Math.round(from.y),
    });
    await sleep(80);
    await rpc('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: Math.round(from.x), y: Math.round(from.y),
      button: 'left', buttons: 1, clickCount: 1,
    });
    // 分步移动：一步跳过去浏览器不会中途重绘选区
    for (let i = 1; i <= 6; i += 1) {
      await rpc('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + ((to.x - from.x) * i) / 6),
        y: Math.round(from.y + ((to.y - from.y) * i) / 6),
        button: 'left', buttons: 1,
      });
      await sleep(35);
    }
    await rpc('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: Math.round(to.x), y: Math.round(to.y),
      button: 'left', buttons: 0, clickCount: 1,
    });
    await sleep(320);
  };
  const readSel = () => evaluate(`(() => {
    const s = window.getSelection();
    return {
      text: s ? s.toString() : '',
      rects: s && s.rangeCount ? s.getRangeAt(0).getClientRects().length : 0,
      cmLayer: document.querySelectorAll('.cm-selectionBackground').length,
    };
  })()`);

  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(1200);

/*
 * 灌文档。
 *
 * 用 `selectAll` + `insertText` 而不是只 `insertText`：
 * 页面里本来就有一份初始内容，只插入会与它叠在一起，
 * 行号对不上（症状是"单击落在第 3 行但目标在第 2 行"）。
 */
const putDoc = async (doc) => {
  await evaluate(`(() => {
    const el = document.querySelector('.cm-content');
    el.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, ${JSON.stringify(doc)});
    return 'ok';
  })()`);
  await sleep(1500);
};

await putDoc([
  'AAA**粗体**BBB',
  '',
  'CCC纯文字DDD',
  '',
  '这一段特意写得非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长，用来触发折行从而检验选区能否横跨多个视觉行；它必须够长，长到在铺满编辑区的宽屏下也绝对装不下，否则这段就不折行，而折行断言会静默跳过。',
  '',
  '',
].join('\n'));

// 坑 1：把光标挪到末尾空行，确保被测行处于渲染态
await pressKey('End', 35);
for (let i = 0; i < 8; i += 1) await pressKey('ArrowDown', 40);
await sleep(900);

  // 坑 2 + 3：用"可见片段"的真实矩形定位
  const probe = await evaluate(`(() => {
    const isHidden = (node, stopAt) => {
      let p = node.parentElement;
      while (p && p !== stopAt) {
        if (getComputedStyle(p).display === 'none') return true;
        p = p.parentElement;
      }
      return false;
    };
    const piecesOf = (line) => {
      const out = [];
      const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!n.data || !n.data.trim()) continue;
        if (isHidden(n, line)) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        const b = r.getBoundingClientRect();
        if (b.width === 0) continue;
        out.push({ text: n.data, x: b.left, w: b.width, cy: b.top + b.height / 2 });
      }
      return out;
    };
    const lines = [...document.querySelectorAll('.cm-line')];
    const marked = lines.find((l) => (l.textContent || '').includes('粗体'));
    const plain = lines.find((l) => (l.textContent || '').includes('CCC'));
    const longLine = [...lines].find((l) => l.getBoundingClientRect().height > 40);
    const pack = (line) => {
      if (!line) return null;
      const ps = piecesOf(line);
      if (ps.length === 0) return null;
      return {
        visibleText: ps.map((p) => p.text).join(''),
        from: { x: ps[0].x + 1, y: ps[0].cy },
        to: { x: ps[ps.length - 1].x + ps[ps.length - 1].w - 1, y: ps[ps.length - 1].cy },
        boldPiece: ps.find((p) => p.text.includes('粗体')) ?? null,
        buffers: line.querySelectorAll('.cm-widgetBuffer').length,
        hiddenMarks: line.querySelectorAll('.cm-md-hidden-mark').length,
      };
    };
    /*
     * 折行行特殊处理：它有多行高度，拖选必须从**第一行的开头**
     * 到**最后一行的结尾**。
     *
     * 不能只用片段的 cy —— 一个片段的 cy 可能是同一行的中线，
     * 拖全程都在同一行的中线高度上，选区自然只覆盖一行，
     * 那样断言"横跨 ≥2 个视觉行"就永远红。
     */
    const packWrapped = (line) => {
      if (!line) return null;
      const ps = piecesOf(line);
      if (ps.length === 0) return null;
      const r = line.getBoundingClientRect();
      return {
        visibleText: ps.map((p) => p.text).join(''),
        from: { x: ps[0].x + 1, y: r.top + 6 },
        to: { x: ps[ps.length - 1].x + ps[ps.length - 1].w - 1, y: r.bottom - 6 },
      };
    };
    return {
      marked: pack(marked),
      plain: pack(plain),
      long: packWrapped(longLine),
    };
  })()`);
  console.log('探针：', JSON.stringify(probe, null, 2));

  // 0) 前置：渲染态必须真的把标记藏了
  if (!probe.marked) {
    note('找不到带标记的行');
  } else {
    if (probe.marked.visibleText.includes('*') || probe.marked.visibleText.includes('~')) {
      note(`渲染态仍在显示标记（可见文本含标记符）：${probe.marked.visibleText}`);
    } else {
      pass(`标记已在渲染态隐藏（可见文本：${probe.marked.visibleText}）`);
    }
    if (probe.marked.buffers > 0) {
      /*
       * 注意这条**只提示不判失败**。
       *
       * 曾断言 widgetBuffer 会打断选区，实测被推翻：改回
       * Decoration.replace 后拖选/双击/折行全部照常通过。
       * 它是 DOM 负担（26 个 <img> 参与布局与命中测试），
       * 但不是选区失效的成因 —— 判失败等于把一个性能问题
       * 报成功能缺陷，久了就没人信这条闸门了。
       */
      console.log(
        `  · 提示：该行有 ${probe.marked.buffers} 个 cm-widgetBuffer（DOM 负担，非功能问题）`,
      );
    } else {
      pass('没有 widgetBuffer（隐藏标记不插额外 DOM 节点）');
    }
  }

  // 1) 拖选有标记的行
  if (probe.marked) {
    await dragSelect(probe.marked.from, probe.marked.to);
    const sel = await readSel();
    console.log('拖选有标记行：', JSON.stringify(sel));
    if (!sel.text) {
      note(`拖选有隐藏标记的行选不到任何内容（应选中 ${JSON.stringify(probe.marked.visibleText.slice(0, 24))}…）`);
    } else if (!sel.text.includes('粗体')) {
      note(`拖选选中了 ${JSON.stringify(sel.text.slice(0, 30))}，但不含「粗体」—— 落点偏移了`);
    } else {
      pass('拖选跨隐藏标记的行正常');
    }
    const shot = await rpc('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, 'selection-marked.png'), Buffer.from(shot.data, 'base64'));
  }

  // 2) 拖选无标记的行（对照组）
  if (probe.plain) {
    await dragSelect(probe.plain.from, probe.plain.to);
    const sel = await readSel();
    console.log('拖选无标记行：', JSON.stringify(sel));
    if (!sel.text) note('对照失败：无标记的行也拖不中，说明不是标记的问题');
    else pass('对照成立：无标记行拖选正常');
  }

  // 3) 折行段落：选区必须横跨多个视觉行
  if (probe.long) {
    await dragSelect(probe.long.from, probe.long.to);
    const sel = await evaluate(`(() => {
      const s = window.getSelection();
      if (!s || !s.rangeCount) return { rects: 0, tops: 0, text: '' };
      const rs = [...s.getRangeAt(0).getClientRects()];
      const tops = [...new Set(rs.map((r) => Math.round(r.top)))];
      return { rects: rs.length, tops: tops.length, text: s.toString() };
    })()`);
    console.log('拖选折行段落：', JSON.stringify(sel));
    if (sel.tops < 2) note(`折行段落的选区只在 ${sel.tops} 个视觉行上（应 ≥ 2）`);
    else pass(`选区正确横跨 ${sel.tops} 个视觉行`);
  } else {
    /*
     * 找不到折行行时必须**报出来**，不能静默跳过。
     *
     * 踩过：测试文本不够长（55 字 × 15px ≈ 825px，而编辑区宽 1182px），
     * 那段根本不折行，于是 `probe.long` 为 null、整条断言被跳过 ——
     * 输出里看起来"全绿"，实际什么都没测。
     * 判据要按**最宽的运行环境**准备数据，并且拿不到目标就失败。
     */
    note('找不到折行的行（测试文本可能不够长，折行断言被跳过了）');
  }

  // 4) 双击选词
  if (probe.marked?.boldPiece) {
    const p = probe.marked.boldPiece;
    const x = Math.round(p.x + p.w / 2);
    const y = Math.round(p.cy);
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
    await sleep(380);
    const sel = await readSel();
    console.log('双击选中：', JSON.stringify(sel));
    if (!sel.text.includes('粗体')) note(`双击选词失败，选中 ${JSON.stringify(sel.text)}`);
    else pass('双击选词正常');
  }

  // 5) 单击落点：光标必须进到点中的那一行
  if (probe.marked?.boldPiece) {
    const p = probe.marked.boldPiece;
    const x = Math.round(p.x + p.w / 2);
    const y = Math.round(p.cy);
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(400);
    const after = await evaluate(`(() => {
      const lines = [...document.querySelectorAll('.cm-line')];
      const i = lines.findIndex((l) => l.classList.contains('cm-activeLine'));
      return { i, text: i >= 0 ? lines[i].textContent : null };
    })()`);
    const markedIdx = await evaluate(`(() => {
      const lines = [...document.querySelectorAll('.cm-line')];
      return lines.findIndex((l) => (l.textContent || '').includes('粗体'));
    })()`);
    console.log('单击之后：', JSON.stringify({ ...after, markedIdx }));
    if (after.i !== markedIdx) {
      note(`单击「粗体」后光标落在第 ${after.i} 行，但目标在第 ${markedIdx} 行 —— 坐标换算有偏差`);
    } else {
      pass('单击落点正确（光标进了点中的那一行）');
    }
  }

  /*
 * 对照组：一份**完全不含任何标记**的文档。
 *
 * 为什么必须有它：先前只测"有标记行 vs 无标记行"（同一文档内），
 * 结果两者都拖不中 —— 而"无标记行"在更早一轮是成功的。
 * 也就是说**同一文档里含标记的那一行会拖累整篇的选区**，
 * 只有"整篇都不含标记"这个对照才能把它和"坐标算错"区分开。
 */
await evaluate(`(() => {
    const el = document.querySelector('.cm-content');
    el.focus();
    document.execCommand('insertText', false, [
      'AAA 纯文字无任何标记','',
      'CCC 也是纯文字没有标记','','',
    ].join('\\n'));
    return 'ok';
  })()`);
await sleep(1500);
await pressKey('End', 35);
for (let i = 0; i < 6; i += 1) await pressKey('ArrowDown', 40);
await sleep(900);

const cleanProbe = await evaluate(`(() => {
    const lines = [...document.querySelectorAll('.cm-line')];
    const line = lines.find((l) => (l.textContent || '').includes('AAA'));
    if (!line) return null;
    const r = line.getBoundingClientRect();
    return {
      from: { x: r.left + 5, y: r.top + r.height / 2 },
      to: { x: r.left + 80, y: r.top + r.height / 2 },
      buffers: line.querySelectorAll('.cm-widgetBuffer').length,
    };
  })()`);
if (cleanProbe) {
  await dragSelect(cleanProbe.from, cleanProbe.to);
  const sel = await readSel();
  console.log('纯文字文档拖选：', JSON.stringify(sel));
  if (!sel.text) {
    note('整篇不含标记的文档也拖不中 —— 问题不在标记，而在拖选方式本身（探针有问题）');
  } else {
    pass(`纯文字文档拖选正常（选中 ${JSON.stringify(sel.text)}）`);
  }
} else {
  note('纯文字对照文档没灌成功');
}

  // 6) 代码块：围栏行必须**彻底**折叠，且代码文字可正常选中。
  //
  // 为什么单独一条：围栏行只把高度归零是不够的 —— 文字留在 DOM 里
  // 就仍会被浏览器原生命中测试选中，症状是"双击代码块里的词，
  // 结果选中了围栏行的 js"。而 CM6 自己的坐标换算是对的
  // （y 矩阵实测：围栏行的 y 区间从未被命中），出问题的是
  // 浏览器双击选词用的 `caretRangeFromPoint`。
  //
  // 所以断言分三层，缺一层都留洞：
  //   1. 围栏行高度为 0（不占位）
  //   2. 围栏行的文字被 display:none 藏掉（不可命中）
  //   3. 双击代码块真的选中代码里的词
  const FENCE = String.fromCharCode(96).repeat(3);
  await putDoc([
    '段落一。', '',
    FENCE + 'js',
    'const answer = 42;',
    'console.log(answer);',
    FENCE, '',
    '段落二。', '',
  ].join('\n'));
  await pressKey('End', 35);
  for (let i = 0; i < 10; i += 1) await pressKey('ArrowDown', 40);
  await sleep(900);

  const codeFacts = await evaluate(`(() => {
    const fence = '${FENCE}';
    const lines = [...document.querySelectorAll('.cm-line')];
    const fenceRows = lines.filter((l) => (l.textContent || '').trim().startsWith(fence));
    const codeRow = lines.find((l) => (l.textContent || '').includes('const answer'));
    const hiddenOf = (l) => [...l.querySelectorAll('.cm-md-hidden-mark')];
    const pieceOf = (l, needle) => {
      const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf(needle);
        if (i < 0) continue;
        let hid = false, p = n.parentElement;
        while (p && p !== l) { if (getComputedStyle(p).display === 'none') { hid = true; break; } p = p.parentElement; }
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + needle.length);
        const b = r.getBoundingClientRect();
        return { x: b.left + 2, w: b.width, cy: b.top + b.height / 2, hidden: hid };
      }
      return null;
    };
    return {
      fenceCount: fenceRows.length,
      fenceHeights: fenceRows.map((l) => Math.round(l.getBoundingClientRect().height)),
      fenceHiddenMarks: fenceRows.map((l) => hiddenOf(l).length),
      fenceVisiblePieces: fenceRows.map((l) => {
        let vis = 0;
        const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          if (!n.data.trim()) continue;
          let hid = false, p = n.parentElement;
          while (p && p !== l) { if (getComputedStyle(p).display === 'none') { hid = true; break; } p = p.parentElement; }
          if (!hid) vis += 1;
        }
        return vis;
      }),
      codeRowText: codeRow ? codeRow.textContent : null,
      codeWord: codeRow ? pieceOf(codeRow, 'answer') : null,
      /* 代码行所有可见片段的矩形，用于水平拖选整行。 */
      codeRowPieces: codeRow ? (() => {
        const out = [];
        const w = document.createTreeWalker(codeRow, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          if (!n.data.trim()) continue;
          let hid = false, p = n.parentElement;
          while (p && p !== codeRow) { if (getComputedStyle(p).display === 'none') { hid = true; break; } p = p.parentElement; }
          if (hid) continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          const b = r.getBoundingClientRect();
          if (b.width === 0) continue;
          out.push({ text: n.data, x: b.left, w: b.width, cy: b.top + b.height / 2 });
        }
        return out;
      })() : null,
      /*
       * 逐字符判"是否被隐藏"。
       *
       * 这比"有几个 hidden-mark 节点"精确：围栏行的文字可能被
       * 两种装饰盖住（逐 token 的标记隐藏 + 整行兜底隐藏），
       * 数节点个数分不清"哪一层"在起作用 —— 实测注入掉整行那层时，
       * 节点数从 3 变 2 但每个字符仍有隐藏祖先，界面毫无变化，
       * 断言也就抓不到。按字符判才反映"用户看不看得见"。
       */
      fenceCharCoverage: fenceRows.map((l) => {
        const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
        let total = 0;
        let covered = 0;
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          if (!n.data.trim()) continue;
          total += 1;
          if (n.parentElement && n.parentElement.closest('.cm-md-hidden-mark')) covered += 1;
        }
        return { total, covered };
      }),
    };
  })()`);
  console.log('\n代码块事实：', JSON.stringify(codeFacts));

  const codeProblems = [];
  if (codeFacts.fenceCount < 2) {
    note(`只找到 ${codeFacts.fenceCount} 个围栏行，代码块断言会恒真`);
  } else {
    if (codeFacts.fenceHeights.some((h) => h > 2)) {
      codeProblems.push(`围栏行没有完全折叠（高度 ${codeFacts.fenceHeights.join('/')}px，应 ≈ 0）`);
    }
    if (codeFacts.fenceHiddenMarks.some((n) => n === 0)) {
      codeProblems.push('围栏行的文字没有被隐藏（会仍被浏览器命中测试选中）');
    }
    if (codeFacts.fenceVisiblePieces.some((n) => n > 0)) {
      codeProblems.push(`围栏行仍有 ${codeFacts.fenceVisiblePieces.join('/')} 个可见文字片段`);
    }
    if (!codeFacts.codeWord || codeFacts.codeWord.hidden) {
      codeProblems.push('代码行的文字不可见，无法测试选中');
    }
  }
  for (const p of codeProblems) console.error('  ✗ ' + p);
  if (codeProblems.length > 0) problems.push(...codeProblems);

  // 在代码行内**水平拖选一整行**。
  //
  // 这条与上面的多行拖选不同：y 不变、只有 x 变化，是最容易暴露
  // "x 落点偏移"的场景 —— 实测单行拖选只选中 2 个字符，
  // 而跨行拖选反而正常（因为跨行时 y 变化会盖过 x 的偏差）。
  //
  // 判据必须是**内容完整性**，不能只判"非空"：
  // 早先这里写的是 `if (!sel.text)`，于是只选中 "on" 也照样通过 ——
  // 一条过松的断言会把真实缺陷放行。
  if (codeFacts.codeRowPieces && codeFacts.codeRowPieces.length >= 2) {
    const ps = codeFacts.codeRowPieces;
    const first = ps[0];
    const last = ps[ps.length - 1];
    await dragSelect(
      { x: first.x + 1, y: first.cy },
      { x: last.x + last.w - 1, y: last.cy },
    );
    const sel = await readSel();
    console.log('代码块单行拖选：', JSON.stringify(sel));
    const got = sel.text.replace(/\s+/g, '');
    const want = codeFacts.codeRowText.replace(/\s+/g, '');
    if (!got.includes(want.slice(0, 5)) || got.length < want.length - 2) {
      note(
        `代码块单行拖选只选中了 ${JSON.stringify(sel.text)}` +
          `（整行是 ${JSON.stringify(codeFacts.codeRowText)}）—— 拖选起止点被 x 坐标带偏了`,
      );
    } else {
      pass(`代码块单行拖选完整（选中 ${got.length}/${want.length} 字符）`);
    }
  }

  // 双击代码行里的词
  if (codeFacts.codeWord && !codeFacts.codeWord.hidden) {
    const cw = codeFacts.codeWord;
    const dx = Math.round(cw.x + cw.w / 2);
    const dy = Math.round(cw.cy);
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x: dx, y: dy, button: 'left', buttons: 1, clickCount: 1 });
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dx, y: dy, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(120);
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x: dx, y: dy, button: 'left', buttons: 1, clickCount: 2 });
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dx, y: dy, button: 'left', buttons: 0, clickCount: 2 });
    await sleep(380);
    const sel = await readSel();
    console.log('代码块内双击：', JSON.stringify(sel));
    if (!sel.text.includes('answer')) {
      note(
        `双击代码块里的 answer 却选中了 ${JSON.stringify(sel.text)}` +
          ' —— 多半命中了围栏行（它的文字还在 DOM 里）',
      );
    } else {
      pass('代码块内双击选中正确');
    }
  }

  // 6) 选区高亮的**颜色**必须来自我们的色板。
  //
  // 为什么必须测：CM6 自带的选择器带了
  // `.cm-focused > .cm-scroller > .cm-selectionLayer` 三个额外 class，
  // 特异性远高于单个 `.cm-selectionBackground`。
  // 写错特异性时 ours 完全不生效，实测计算值是 CM6 默认的
  // `rgb(34,51,51)` —— 浅色主题下就是一块黑，选中的字被盖住。
  // 那个 bug **不报错、不影响任何断言**，只有读计算值才看得见。
  const selColor = await evaluate(`(() => {
    const line = [...document.querySelectorAll('.cm-line')]
      .find((l) => (l.textContent || '').trim().length > 0);
    if (!line) return null;
    const first = document.createTreeWalker(line, NodeFilter.SHOW_TEXT).nextNode();
    const r = document.createRange();
    r.setStart(first, 0);
    r.setEnd(first, Math.min(3, first.data.length));
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return new Promise((res) => setTimeout(() => {
      const bg = document.querySelector('.cm-selectionBackground');
      res({
        varValue: getComputedStyle(document.documentElement)
          .getPropertyValue('--md-selection').trim(),
        computed: bg ? getComputedStyle(bg).backgroundColor : null,
      });
    }, 350));
  })()`);

  if (!selColor || !selColor.computed) {
    note('读不到选区高亮的计算颜色（选区层没建起来？）');
  } else if (!sameColor(selColor.computed, selColor.varValue)) {
    /*
     * 比**数值**而不是比字符串：CSS 变量的原文是 `rgba(43, 111, 212, .18)`，
     * 计算值是 `rgba(43, 111, 212, 0.18)` —— 同一颜色，不同写法。
     * 直接比字符串会永远判失败，而那条断言一旦恒红就等于没有。
     */
    note(
      `选区高亮色不来自色板：计算值 ${selColor.computed}` +
        ` ≠ --md-selection ${selColor.varValue} —— 多半是被 CM6 默认样式压住了`,
    );
  } else {
    pass(`选区高亮使用了色板值（${selColor.computed}）`);
  }

  ws.close();
} catch (error) {
  console.error('检查失败：', error.message);
  problems.push(error.message);
} finally {
  killBrowserTree(chrome);
  try {
    server.close();
  } catch {
    /* 已关闭 */
  }
  await sleep(300);
}

console.log(
  problems.length > 0
    ? `\n选区检查发现 ${problems.length} 个问题`
    : '\n选区行为全部正常（拖选 / 双击 / 单击落点 / 折行横跨）',
);
process.exit(problems.length > 0 ? 1 : 0);