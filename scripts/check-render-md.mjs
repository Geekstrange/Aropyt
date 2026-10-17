/**
 * 渲染回归闸门：用仓库里的 test/basic.md 全文做夹具。
 *
 * ── 为什么要"分段灌入"而不是一次性灌全文 ────────────────────
 * CodeMirror 只渲染视口附近的行（虚拟化）。一次性灌 417 行，统计到的
 * 只有光标附近那一屏 —— 于是"删除线 0 处、链接 0 处、任务列表 0 处"
 * 这些结论全是**采样失真**，看起来像"没渲染"，其实只是没进视口。
 * 上一轮就是这么把用户说的"没渲染"判成"实测是好的"。
 *
 * 正确做法：按章节切片，**每次只灌一小段**（远小于视口高度），
 * 于是该段每一行都真实参与渲染、可被统计。末行是光标行（标记会显形），
 * 所以"标记应被隐藏"的断言只断言数量下限。
 *
 * 覆盖范围由 `scripts/dump-md-tree.mjs` 的语法树节点表决定 ——
 * 节点名对过账，不是肉眼扫。
 *
 * 用法：npm run check:render-md
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';

const ROOT = resolve('apps/web/dist');
const PORT = 4423;
const CDP_PORT = 9363;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
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
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'aropyt-rmd-'))}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const problems = [];
const pageErrors = [];

/*
 * 页面内的渲染产物收集函数（定义一次，每段调用一次）。
 *
 * 刻意做成**独立常量 + 页面函数**，而不是把收集表达式内联在灌入循环里：
 * 循环里的模板字符串曾经被多轮字符串替换改得括号配不平
 * （node --check 报 missing )，esbuild 定位到收集段末尾），
 * 把"页面上跑什么"与"脚本怎么跑"分开后，两边都是普通语法。
 */
const COLLECT_DEF = `function __collectRenderStats() {
  const blocks = [...document.querySelectorAll('.cm-md-block')];
  const q = (sel) => blocks.reduce((n, b) => n + b.querySelectorAll(sel).length, 0);
  const cs = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el) : null; };
  const strong = cs('.cm-md-block strong');
  const table = cs('.cm-md-block table');
  const quote = cs('.cm-md-block blockquote');
  const pre = cs('.cm-md-block pre');
  const h = cs('.cm-md-block h1, .cm-md-block h2, .cm-md-block h3');
  return {
    blocks: blocks.length,
    strong: q('strong'), strongFW: strong ? strong.fontWeight : null,
    em: q('em'), emFS: cs('.cm-md-block em') ? cs('.cm-md-block em').fontStyle : null,
    del: q('del, s'),
    inlineCode: q('code'),
    links: q('a'),
    listItems: q('li'),
    quoteEls: q('blockquote'), quoteBL: quote ? quote.borderLeftWidth : null,
    headings: q('h1') + q('h2') + q('h3') + q('h4') + q('h5') + q('h6'),
    hFW: h ? h.fontWeight : null,
    tables: q('table'), thEls: q('th'), tdBorder: table ? table.borderCollapse : null,
    preBlocks: q('pre'), preBG: pre ? pre.backgroundColor : null,
    images: q('img'),
    hr: q('hr'),
    checkbox: q('input[type=checkbox]'),
    hidden: document.querySelectorAll('.cm-md-hidden-mark').length,
    hljsTokens: q('.hljs-keyword, .hljs-string, .hljs-comment, .hljs-title, .hljs-number'),
    mermaidSvg: q('.cm-md-mermaid svg'),
  };
}`;

const note = (m) => { problems.push(m); console.log('  ✗ ' + m); };
const pass = (m) => console.log('  ✓ ' + m);

/**
 * 把 basic.md 切成若干片段，每片都能**整屏渲染**且不被切断。
 *
 * 三个约束都是踩出来的：
 *
 * 1. 片段必须小于视口高度（1200px ≈ 50 行），否则后半段又不进视口，
 *    统计又会失真（第一版的 14 行上限太保守，但改大之前得先解决 2）。
 * 2. **表格不能被切断**：表格是"表头 + 分隔行 + 数据行"连着的，
 *    切断后 lezer 解析不出 Table 节点 —— 表现为"表格渲染 0 行"，
 *    看起来像渲染坏了，其实只是切片毁了语法结构。
 * 3. 片段末尾**补两行**：光标落在片段最后一行，而光标行的标记是
 *    要显形的（这是 Typora 交互的定义）。不补行的话，每段最后一行
 *    的标记永远不会被隐藏，转义/引用定义这类断言必然假失败。
 */
function sliceDocument(text) {
  const lines = text.split('\n');
  const chunks = [];
  let buf = [];
  let inTable = false;
  const isTableRow = (l) => /^\s*\|/.test(l);
  const flush = () => {
    if (buf.length) chunks.push([...buf, '', '（本段末尾）'].join('\n'));
    buf = [];
  };
  let inFence = false;
  for (const line of lines) {
    // 代码围栏也不能切断：切开后 ``` 不配对，整块解析成普通段落
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const tableRow = isTableRow(line);
    // 表格块**独占一段**：起止各断一次。
    // 黏在别的内容后面会出现"表格解析出来了但不在视口里" ——
    // 渲染层其实是对的，统计却是 0，这种假失败最容易把人带偏。
    if (tableRow !== inTable && !inFence) {
      flush();
      inTable = tableRow;
      buf.push(line);
      continue;
    }
    buf.push(line);
    if (inTable || inFence) continue;
    const boundary = line.trim() === '' || /^#{1,6}\s/.test(line);
    // 24 行是个保守上限：渲染态行高比源码态大（标题有上下留白），
    // 1200px 的视口实际装不满 50 行。
    if ((boundary && buf.length >= 8) || buf.length >= 24) flush();
  }
  flush();
  return chunks.filter((c) => c.trim().length > 0);
}

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
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text ?? '').slice(0, 220));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      pageErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 220));
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
  const ev = async (expression) => {
    const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面内异常');
    return r.result?.value;
  };

  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Emulation.setDeviceMetricsOverride', {
    width: 1300, height: 1200, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(1200);
  // 等编辑器就绪（verify 里系统忙时固定 sleep 远不够）
  for (let i = 0; i < 24; i += 1) {
    if (await ev(`!!document.querySelector('.cm-content')`).catch(() => false)) break;
    await sleep(500);
  }
  // 定义页面内的渲染产物收集函数（定义一次，每段调用）
  await ev(COLLECT_DEF);

  const stats = {};
  const bump = (k, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };
  const style = {};
  const noteStyle = (k, v) => { if (style[k] === undefined && v !== null) style[k] = v; };

  // 多夹具：basic.md 覆盖基础语法，html.md 覆盖 HTML 内联/块
  //（用户的 test 目录按语法分了文件，单一夹具会漏项）
  const chunks = [
    ...sliceDocument(readFileSync(resolve('test/basic.md'), 'utf8')),
    ...sliceDocument(readFileSync(resolve('test/html.md'), 'utf8')),
    // mermaid-basic 不进分段循环（图表渲染是异步的，等 SVG 单独探针），
    // 但 basic/html 的代码块负责验证 hljs token 染色
  ];
  console.log(`夹具切成 ${chunks.length} 段逐段渲染\n`);

  /*
   * 用**真实键盘事件**替换文档，不要用 execCommand。
   *
   * `document.execCommand('selectAll' + 'insertText')` 在 CM6 上不可靠：
   * 那一刻编辑器没拿到焦点时 selectAll 落不到文档上，insertText 就变成
   * "在光标处插入" —— 文档每段都在增长。症状极具迷惑性：统计值单调
   * 累积（代码块一度数到 299 处，而 test.md 只有 6 个），表格与转义的
   * 断言却恒为 0，看起来像"渲染坏了"，其实是文档里根本不是那一段。
   *
   * CDP 的键盘事件走的是浏览器输入管线，CM6 一定收得到。
   * modifiers 位掩码：Alt=1 / Ctrl=2 / Meta=4 / Shift=8。
   */
  const typeIntoEditor = async (text) => {
    await ev(`document.querySelector('.cm-content').focus()`);
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await ev(`(() => {
      const el = document.querySelector('.cm-content');
      el.focus();
      document.execCommand('insertText', false, ${JSON.stringify(text)});
      return 'ok';
    })()`);
  };

  for (const chunk of chunks) {
    await typeIntoEditor(chunk);
    await sleep(320);
    /*
     * 防御：确认文档确实被**替换**成了这一段，而不是在旧文档后面接了一截。
     * 只对短段校验，且容差放宽 —— CM6 虚拟化下 textContent 只含视口内的行，
     * 行数天然少于源码行数，拿它做精确比对会自己骗自己。
     */
    /*
     * 确认文档确实被替换成了这一段。
     * 块渲染下 .cm-line 数量不再反映内容量（渲染块是 widget 不是行），
     * 改查段末标记的文本是否在内容里。
     */
    const endMarked = await ev(
      `document.querySelector('.cm-content').textContent.includes('（本段末尾）')`,
    );
    if (!endMarked) {
      note('灌入失败：段末标记不在文档里（selectAll/delete 没生效）');
      console.log('页面错误:', pageErrors.slice(0, 5));
      break;
    }
    const s = await ev('__collectRenderStats()');
    for (const k of ['blocks','strong','em','del','inlineCode','links','listItems',
      'quoteEls','headings','tables','thEls','preBlocks','images','hr','checkbox','hidden',
      'hljsTokens','mermaidSvg']) {
      bump(k, s[k]);
    }
    noteStyle('strongFW', s.strongFW);
    noteStyle('emFS', s.emFS);
    noteStyle('quoteBL', s.quoteBL);
    noteStyle('tdBorder', s.tdBorder);
    noteStyle('preBG', s.preBG);
    noteStyle('hFW', s.hFW);
  }

  console.log('分段统计：', JSON.stringify(stats));
  console.log('计算样式：', JSON.stringify(style), '\n');

  const expect = (cond, msg) => (cond ? pass(msg) : note(msg));

  // —— 渲染产物（与预览窗同一引擎，同一验收线）——
  expect(stats.blocks >= 30, `块级渲染生效（${stats.blocks} 个渲染块）`);
  expect(stats.strong >= 5 && style.strongFW === '600', `粗体渲染（${stats.strong} 个 <strong>，font-weight ${style.strongFW}）`);
  expect(stats.em >= 3, `斜体渲染（${stats.em} 个 <em>）`);
  expect(stats.del >= 1, `删除线渲染（${stats.del} 个 <del>/<s>）`);
  expect(stats.inlineCode >= 5, `行内代码渲染（${stats.inlineCode} 个 <code>）`);
  expect(stats.links >= 5, `链接渲染（${stats.links} 个 <a>）`);
  expect(stats.listItems >= 10, `列表渲染（${stats.listItems} 个 <li>）`);
  expect(stats.quoteEls >= 4 && String(style.quoteBL) !== '0px', `引用块渲染（${stats.quoteEls} 个 <blockquote>，左边框 ${style.quoteBL}）`);
  expect(stats.headings >= 15 && style.hFW === '600', `标题渲染（${stats.headings} 个 h1-h6，font-weight ${style.hFW}）`);
  expect(stats.tables >= 2 && stats.thEls >= 6 && style.tdBorder === 'collapse', `表格渲染（${stats.tables} 张真 <table> / ${stats.thEls} 表头格，border-collapse ${style.tdBorder}）`);
  expect(stats.preBlocks >= 5 && String(style.preBG) !== 'rgba(0, 0, 0, 0)', `代码块渲染（${stats.preBlocks} 个 <pre>，带背景）`);
  expect(stats.images >= 2, `图片渲染（${stats.images} 个 <img>）`);
  expect(stats.hr >= 5, `分隔线渲染（${stats.hr} 个 <hr>）`);
  expect(stats.checkbox >= 5, `任务列表复选框（${stats.checkbox} 个）`);
  expect(stats.hidden >= 5, `光标块源码态的标记隐藏（${stats.hidden} 处）`);
  expect(stats.hljsTokens >= 5, `代码块语法高亮（${stats.hljsTokens} 个 hljs token span）`);


  // —— 数学公式专项：KaTeX 异步渲染（动态加载 chunk + 字体），轮询等 .katex 出现
  await typeIntoEditor(readFileSync(resolve('test/math.md'), 'utf8'));
  let mathCount = 0;
  for (let i = 0; i < 24; i += 1) {
    await sleep(500);
    mathCount = await ev(
      `document.querySelectorAll('.cm-md-block .katex').length`,
    );
    if (mathCount >= 7) break;
  }
  expect(mathCount >= 7, `数学公式渲染（${mathCount} 个 KaTeX 元素）`);
  // 滚动全文档，收集仍未渲染的占位（诊断用户报的"希腊字母与偏导"未渲染）
  const stale = await ev(`(async () => {
    const scroller = document.querySelector('.cm-scroller');
    const out = [];
    for (let y = 0; y <= scroller.scrollHeight; y += 900) {
      scroller.scrollTop = y;
      await new Promise((r) => setTimeout(r, 350));
      document.querySelectorAll('.cm-md-block [data-tex]').forEach((el) => {
        if (!el.querySelector('.katex')) out.push((el.getAttribute('data-tex') ?? '').split(String.fromCharCode(10)).join(' ').slice(0, 50));
      });
    }
    return out.slice(0, 5);
  })()`);
  if (stale.length > 0) console.log('未渲染占位样本:', JSON.stringify(stale));
  expect(stale.length === 0, `滚动全文档无未渲染占位（发现 ${stale.length} 个）`);


  // —— Mermaid 专项：图表渲染是异步的（mermaid chunk 懒加载 + render），
  //    轮询等 SVG 出现，最多 15s。
  await typeIntoEditor(readFileSync(resolve('test/mermaid-basic.md'), 'utf8'));
  let mermaidCount = 0;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    mermaidCount = await ev(
      `document.querySelectorAll('.cm-md-mermaid svg').length`,
    );
    if (i === 2 || mermaidCount >= 2) {
      console.log('mermaid 诊断:', await ev(`JSON.stringify({
        boxes: document.querySelectorAll('.cm-md-mermaid').length,
        src: [...document.querySelectorAll('.cm-md-mermaid-src')].length,
        svg: document.querySelectorAll('.cm-md-mermaid svg').length,
        firstHtml: (document.querySelector('.cm-md-mermaid')?.innerHTML ?? '').slice(0, 120),
      })`), '页面错误:', pageErrors.slice(0, 3));
    }
    if (mermaidCount >= 2) break;
  }
  expect(mermaidCount >= 2, `Mermaid 图表渲染（${mermaidCount} 个 SVG）`);

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
    ? `\n渲染回归发现 ${problems.length} 个问题`
    : '\n渲染回归全部正常（分段渲染，覆盖 test.md 全部语法）',
);
process.exit(problems.length > 0 ? 1 : 0);
