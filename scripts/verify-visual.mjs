/**
 * Typora 渲染的端到端可视化验证。
 *
 * 之前的 `check:render` 是静态断言（在 node 里跑装饰规则），
 * 它能证明"规则对"，但证明不了"真的渲染出来了" ——
 * 中间的 CM6 装配、CSS 生效、字体是否被覆盖，全都不在它的覆盖范围。
 *
 * 这个脚本补上那一段：真的起浏览器、真的往编辑器里打字、真的截图，
 * 并从 DOM 里读回客观事实（行装饰数量、标记元素宽度、字体族）。
 *
 * 用法：node scripts/verify-visual.mjs
 * 产物：screenshots/typora-*.png
 */

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs';
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
const OUT_DIR = resolve('screenshots');
const PORT = 4399;
const CDP_PORT = 9333;

if (!existsSync(ROOT)) {
  console.error('先构建：npm run build');
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });

// ── 静态服务（必须是本进程的子对象，否则调用一结束就被回收）──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer((req, res) => {
  const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const relative = pathname.split('/').filter((s) => s !== '' && s !== '.' && s !== '..');
  let filePath = join(ROOT, ...relative);
  const resolved = resolve(filePath);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(readFileSync(filePath));
  } catch {
    try {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(ROOT, 'index.html')));
    } catch {
      res.writeHead(404).end();
    }
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// ── Chrome ──
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'aropyt-vis-'))}`,
    '--window-size=1440,900',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = `http://127.0.0.1:${CDP_PORT}`;

let code = 0;
try {
  // 等端口就绪
  const deadline = Date.now() + 25000;
  for (;;) {
    try {
      if ((await fetch(`${CDP}/json/version`)).ok) break;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error('DevTools 未就绪');
    await sleep(400);
  }

  let target;
  try {
    const r = await fetch(`${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/`)}`, {
      method: 'PUT',
    });
    target = await r.json();
  } catch {
    target = await (await fetch(`${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/`)}`)).json();
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('WS 连接失败'));
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
    new Promise((resolvePromise, reject) => {
      const id = ++seq;
      const t = setTimeout(() => reject(new Error(`${method} 超时`)), 30000);
      pending.set(id, (m) => {
        clearTimeout(t);
        if (m.error) reject(new Error(`${method}: ${m.error.message}`));
        else resolvePromise(m.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '页面内异常');
    return r.result?.value;
  };

  await rpc('Page.enable');
  await rpc('Runtime.enable');

  /*
   * 把系统偏好**固定**为深色再开始。
   *
   * 不固定的话结果取决于宿主：无头 Chrome 默认上报 light，
   * 于是默认的 auto 一上来就是浅色，"深色渲染"那几张截图会名不副实 ——
   * 测试通过但测的不是想测的东西。显式模拟才可复现。
   *
   * 顺带这也验证了 auto 分支：偏好是 auto 时，模拟值变化应当实时反映到界面上。
   */
  await rpc('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await sleep(4000); // 等应用装配完成

  const SAMPLE = [
    '# Aropyt 渲染验证',
    '',
    '这是一段普通段落，用来观察行高与字号。',
    '',
    '## 二级标题的样子',
    '',
    '这里有**粗体**、*斜体*、`行内代码`，还有一个[链接](https://example.com)。',
    '',
    '- 列表项一',
    '- 列表项二',
    '',
    '> 这是一段引用文字。',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    '### 三级标题',
    '',
    '最后一段，光标会停在这里，所以上面各行的标记都会隐藏。',
  ].join('\n');

  // 1) 聚焦编辑区
  await evaluate(`document.querySelector('.cm-content')?.focus(); 'focused'`);
  await sleep(300);

  // 2) 灌入文本。用 Input.insertText 而不是逐键敲 ——
  //    逐键会有 IME 与快捷键副作用，而且慢。
  await rpc('Input.insertText', { text: SAMPLE });
  await sleep(2000);

  // 3) 把光标移到文档末尾（最后一段），让上面的标记全部进入"隐藏"状态
  await evaluate(`(() => {
    const el = document.querySelector('.cm-content');
    if (!el) return 'no-content';
    el.focus();
    return 'ok';
  })()`);
  await sleep(1200);

  // 4) 截图 A：渲染态（光标在末段，上面标记应隐藏）
  const shotA = await rpc('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT_DIR, 'typora-rendered.png'), Buffer.from(shotA.data, 'base64'));
  console.log('已保存 screenshots/typora-rendered.png');

  // 5) DOM 客观事实
  const facts = await evaluate(`(() => {
    const q = (s) => document.querySelectorAll(s).length;
    const scroller = document.querySelector('.cm-scroller');
    const cs = scroller ? getComputedStyle(scroller) : null;
    const h1 = document.querySelector('.cm-md-h1');
    const h1cs = h1 ? getComputedStyle(h1) : null;

    // 被 Decoration.replace 隐藏的标记，宽度应为 0
    const hiddenMarks = [...document.querySelectorAll('.cm-line')]
      .flatMap((line) => [...line.querySelectorAll('span')])
      .filter((sp) => sp.textContent && /^[#*>\`\\-]+$/.test(sp.textContent))
      .map((sp) => ({ text: sp.textContent, w: sp.getBoundingClientRect().width }));

    return {
      hasEditor: !!document.querySelector('.cm-content'),
      lineCount: q('.cm-line'),
      h1Count: q('.cm-md-h1'),
      h2Count: q('.cm-md-h2'),
      h3Count: q('.cm-md-h3'),
      strongCount: q('.cm-md-strong'),
      emCount: q('.cm-md-em'),
      inlineCodeCount: q('.cm-md-inline-code'),
      linkCount: q('.cm-md-link'),
      quoteCount: q('.cm-md-quote'),
      codeCount: q('.cm-md-code'),
      gutterVisible: q('.cm-gutters') > 0 && getComputedStyle(document.querySelector('.cm-gutters')).display !== 'none',
      scrollerFont: cs ? cs.fontFamily : null,
      scrollerSize: cs ? cs.fontSize : null,
      h1FontSize: h1cs ? h1cs.fontSize : null,
      h1FontWeight: h1cs ? h1cs.fontWeight : null,
      textWidth: (() => { const c = document.querySelector('.cm-content'); return c ? Math.round(c.getBoundingClientRect().width) : 0; })(),
      scrollerWidth: (() => { const s = document.querySelector('.cm-scroller'); return s ? Math.round(s.getBoundingClientRect().width) : 0; })(),
      hiddenMarks,
      visibleText: (document.querySelector('.cm-content')?.textContent ?? '').slice(0, 90),
    };
  })()`);

  console.log('\nn── 渲染事实 ──');
  console.log(JSON.stringify(facts, null, 2));

  // 6) 判定
  const problems = [];
  if (!facts.hasEditor) problems.push('编辑器未挂载');
  if (facts.h1Count < 1) problems.push('一级标题没有行装饰');
  if (facts.h2Count < 1) problems.push('二级标题没有行装饰');
  if (facts.strongCount < 1) problems.push('粗体没有装饰');
  if (facts.inlineCodeCount < 1) problems.push('行内代码没有装饰');
  if (facts.linkCount < 1) problems.push('链接没有装饰');
  if (facts.gutterVisible) problems.push('渲染态不该显示行号栏');
  if (/mono|Consolas|Courier/i.test(facts.scrollerFont ?? '')) {
    problems.push(`渲染态字体仍是等宽：${facts.scrollerFont}`);
  }
  /*
   * 正文宽度：**不设上限**，必须铺满编辑区。
   *
   * 这里原来断言的是"正文不超过 900px"（当时有 `max-width: 46em`）。
   * 那条规则在 1600px 视口下让左右各空 334px，看起来像"内容只在中间"——
   * 桌面编辑器的窗口宽度是用户自己拉的，替他做这个决定只会显得没铺开。
   * 现在断言反向：正文宽度必须接近编辑区宽度。
   *
   * 判据用"与 scroller 的差值"而不是绝对值：绝对值会随视口变，
   * 恒红的断言等于没有断言。
   */
  if (facts.textWidth < 400) {
    problems.push(`正文过窄（${facts.textWidth}px），内容没有铺开`);
  }
  if (
    typeof facts.scrollerWidth === 'number' &&
    facts.scrollerWidth - facts.textWidth > 80
  ) {
    problems.push(
      `正文没有铺满编辑区：编辑区 ${facts.scrollerWidth}px，正文只有 ${facts.textWidth}px` +
        `（左右共空 ${facts.scrollerWidth - facts.textWidth}px）`,
    );
  }

  // 标记是否真的被隐藏（宽度接近 0）
  const stillVisible = facts.hiddenMarks.filter((m) => m.w > 2);
  if (stillVisible.length > 0) {
    problems.push(`有标记未被隐藏：${JSON.stringify(stillVisible.slice(0, 5))}`);
  }

  console.log('\nn── 判定 ──');
  if (problems.length === 0) {
    console.log('全部通过：Typora 渲染已生效');
  } else {
    for (const p of problems) console.log('  ✗ ' + p);
    code = 1;
  }

  // 7) 截图 B：源码模式对照。
  //
  // 用**点击工具栏按钮**而不是模拟 Ctrl+/：两者走同一条代码路径
  // （都调用 runtime.toggleSourceMode），但按钮点击不依赖
  // keymap 的事件解析，能把"切换逻辑坏"与"快捷键没接上"区分开。
  const toggled = await evaluate(`(() => {
    const btn = document.querySelector('button[aria-label="进入源码模式"]');
    if (!btn) return 'NO_BUTTON';
    btn.click();
    return 'clicked';
  })()`);
  console.log('源码模式按钮:', toggled);
  await sleep(1500);

  const shotB = await rpc('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT_DIR, 'typora-source-mode.png'), Buffer.from(shotB.data, 'base64'));
  console.log('已保存 screenshots/typora-source-mode.png');

  const afterToggle = await evaluate(`(() => ({
    gutter: !!document.querySelector('.cm-gutters'),
    // 源码模式下 # 应该重新可见（渲染态是被装饰藏起来的）
    markerVisible: (document.querySelector('.cm-content')?.textContent ?? '').includes('#'),
    decoratedRanges: document.querySelectorAll('[class*="cm-md-"]').length,
    font: getComputedStyle(document.querySelector('.cm-scroller')).fontFamily,
  }))()`);
  console.log('切换后：', JSON.stringify(afterToggle));

  const sourceProblems = [];
  if (!afterToggle.markerVisible) sourceProblems.push('源码模式下标记应可见');
  if (afterToggle.decoratedRanges > 0) sourceProblems.push('源码模式不该有渲染装饰');
  if (!afterToggle.gutter) sourceProblems.push('源码模式应显示行号栏');
  if (!/mono|Consolas|Courier/i.test(afterToggle.font ?? '')) {
    sourceProblems.push(`源码模式字体应为等宽，实际：${afterToggle.font}`);
  }
  if (sourceProblems.length > 0) {
    for (const p of sourceProblems) console.log('  ✗ ' + p);
    code = 1;
  } else {
    console.log('源码模式切换正常');
  }

  // 8) 切回渲染态，确认可逆 —— 单向切换等于把用户困在源码模式里
  await evaluate(`document.querySelector('button[aria-label="退出源码模式"]')?.click(); 'back'`);
  await sleep(1500);
  const back = await evaluate(`(() => ({
    gutter: !!document.querySelector('.cm-gutters'),
    markerHidden: !(document.querySelector('.cm-content')?.textContent ?? '').includes('# 标题'),
    font: getComputedStyle(document.querySelector('.cm-scroller')).fontFamily,
  }))()`);
  console.log('切回渲染态：', JSON.stringify(back));
  if (back.gutter || !back.markerHidden || !/system-ui|Segoe|PingFang/i.test(back.font ?? '')) {
    console.log('  ✗ 切回渲染态失败（切模式必须是可逆的）');
    code = 1;
  } else {
    console.log('切回渲染态正常');
  }

  /*
   * 9) Ctrl+/ 必须**真的**切换源码模式。
   *
   * 上面那条刻意只点按钮，理由是"能把切换逻辑坏与快捷键没接上区分开"。
   * 这条推理本身没错，但它把一个洞留了下来：**快捷键没接上**恰恰是
   * 实际发生的故障，而且没人测。
   *
   * 真因：@codemirror/commands 的 defaultKeymap 自带
   * `{ key: "Mod-/", run: toggleComment }`，而 CM6 同一批 keymap 里
   * 前面的优先 —— 自有的 Mod-/ 排在它后面，于是 Ctrl+/ 变成了
   * "注释选中行"。按钮照常工作，所以只有真按键才测得出来。
   *
   * 用 Input.dispatchKeyEvent 而不是合成 KeyboardEvent：
   * 合成事件不满足 isTrusted，而且 CDP 这条路才真的走浏览器的事件派发。
   */
  const pressCtrlSlash = async () => {
    const base = {
      modifiers: 2, // 1=Alt 2=Ctrl 4=Meta 8=Shift
      key: '/',
      code: 'Slash',
      windowsVirtualKeyCode: 191,
      nativeVirtualKeyCode: 191,
    };
    // rawKeyDown 不带 text：带 text 会顺手把 "/" 插进文档，
    // 那样测的就不是键位而是"有没有输入斜杠"。
    await rpc('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  await evaluate(`document.querySelector('.cm-content')?.focus(); 'focused'`);
  await sleep(300);
  await pressCtrlSlash();
  await sleep(1500);

  const viaKey = await evaluate(`(() => ({
    gutter: !!document.querySelector('.cm-gutters'),
    modeClass: document.querySelector('.cm-editor')?.className ?? '',
    // 整篇都要看：被注释掉时 <!-- --> 会插在**光标所在行**，
    // 而那一刻光标在文档末尾 —— 只截前 40 个字符必然看不到。
    content: document.querySelector('.cm-content')?.textContent ?? '',
  }))()`);
  console.log('Ctrl+/ 之后：', JSON.stringify({ ...viaKey, content: viaKey.content.slice(0, 40) }));

  const keyProblems = [];
  if (!viaKey.modeClass.includes('aropyt-source-mode')) {
    keyProblems.push(`Ctrl+/ 没有切到源码模式（根节点类：${viaKey.modeClass}）`);
  }
  if (!viaKey.gutter) keyProblems.push('Ctrl+/ 切模式后没有出现行号栏');
  /*
   * 被"注释"掉的证据：@codemirror/lang-markdown 给 markdown 定义了
   * commentTokens = { block: { open: "<!--", close: "-->" } }，
   * 而 defaultKeymap 的 Mod-/ 正是 toggleComment ——
   * 所以这个 bug 的现场不是"没反应"，是文档里凭空多出一对 HTML 注释。
   */
  if (viaKey.content.includes('<!--')) {
    keyProblems.push('Ctrl+/ 被当成了"切换注释"：文档里出现了 <!-- -->');
  }

  // 再按一次必须切回来 —— 单向切换等于把用户困在源码模式里
  await evaluate(`document.querySelector('.cm-content')?.focus(); 'focused'`);
  await sleep(200);
  await pressCtrlSlash();
  await sleep(1500);
  const viaKeyBack = await evaluate(
    `document.querySelector('.cm-editor')?.className ?? ''`,
  );
  if (!viaKeyBack.includes('aropyt-render-mode')) {
    keyProblems.push(`再按一次 Ctrl+/ 没有切回渲染态（根节点类：${viaKeyBack}）`);
  }

  if (keyProblems.length > 0) {
    for (const p of keyProblems) console.log('  ✗ ' + p);
    code = 1;
  } else {
    console.log('Ctrl+/ 双向切换正常');
  }

  /*
   * 10) 渲染态的折行：这是"渲染有问题且插入符串行"的根因所在。
   *
   * CM6 默认给 `.cm-content` / `.cm-line` 都设了 `white-space: pre` ——
   * 那对**源码编辑器**是对的（一行源码就是一个视觉行），
   * 但渲染态要的是文档排版：不折行的话一段长文字会整段横向溢出
   * （实测 clientWidth 690 / scrollWidth 1005），右侧被裁掉，
   * 而"没有下一行"正是光标与文字对不上的来源。
   *
   * 断言分三层，缺一层都留洞：
   *   1. white-space 确实是 pre-wrap（规则对）
   *   2. scrollWidth == clientWidth（没溢出，装配也对）
   *   3. 长行的实际高度是单行的两倍（真的折了，不是碰巧）
   */
  await evaluate(`(() => {
    const el = document.querySelector('.cm-content');
    el.focus();
    document.execCommand('insertText', false, [
      '# 折行验证标题',
      '',
      /*
       * 这段必须**足够长**。
       *
       * 换个窄一点的编辑器它就折行了，但这里正文铺满编辑区（实测 1182px），
       * 长度不够的话根本不会折 —— 于是"折行"那条断言会因为测试数据
       * 而不是产品行为失败。写断言时要按**最宽的运行环境**准备数据。
       */
      '这是一段专门用来验证折行的长正文，它必须有足够多的字，长到现在这个铺满编辑区的宽度下也绝对装不下，这样才能触发软折行并暴露光标坐标的问题。'
        + '如果它不够长，那么在宽屏上就不会折行，断言会误判成产品缺陷。'
        + '所以这里刻意写得非常长，远超任何常见窗口宽度下的单行容量，确保测试意图稳定成立。',
      '',
      '短。',
    ].join('\\n'));
    return 'typed';
  })()`);
  await sleep(1200);

  const wrapFacts = await evaluate(`(() => {
    const lines = [...document.querySelectorAll('.cm-line')];
    const pick = (t) => lines.find((l) => (l.textContent || '').includes(t));
    const long = pick('这是一段专门用来验证折行');
    const short = pick('短。');
    const content = document.querySelector('.cm-content');
    const cs = getComputedStyle(content);
    return {
      contentWhiteSpace: cs.whiteSpace,
      contentOverflowWrap: cs.overflowWrap,
      lineWhiteSpace: long ? getComputedStyle(long).whiteSpace : null,
      contentClient: content.clientWidth,
      contentScroll: content.scrollWidth,
      longHeight: long ? Math.round(long.getBoundingClientRect().height) : -1,
      shortHeight: short ? Math.round(short.getBoundingClientRect().height) : -1,
      // 横向滚动条不该存在（不折行的直接证据）
      scrollerOverflowX: document.querySelector('.cm-scroller').scrollWidth -
                        document.querySelector('.cm-scroller').clientWidth,
    };
  })()`);
  console.log('\n折行事实：', JSON.stringify(wrapFacts));

  const wrapProblems = [];
  if (wrapFacts.contentWhiteSpace !== 'pre-wrap' || wrapFacts.lineWhiteSpace !== 'pre-wrap') {
    wrapProblems.push(
      `渲染态没有折行：content=${wrapFacts.contentWhiteSpace} line=${wrapFacts.lineWhiteSpace}（应为 pre-wrap）`,
    );
  }
  if (wrapFacts.contentScroll > wrapFacts.contentClient) {
    wrapProblems.push(
      `内容横向溢出：scrollWidth ${wrapFacts.contentScroll} > clientWidth ${wrapFacts.contentClient}`,
    );
  }
  if (wrapFacts.scrollerOverflowX > 1) {
    wrapProblems.push(`编辑器出现了横向滚动（溢出 ${wrapFacts.scrollerOverflowX}px），说明该折的没折`);
  }
  if (wrapFacts.longHeight <= wrapFacts.shortHeight) {
    wrapProblems.push(
      `长行没有真正折行：高度 ${wrapFacts.longHeight} 未超过单行的 ${wrapFacts.shortHeight}`,
    );
  }
  if (wrapProblems.length > 0) {
    for (const p of wrapProblems) console.log('  ✗ ' + p);
    code = 1;
  } else {
    console.log('渲染态折行正常，无横向溢出');
  }

  /*
   * 11) 细滚动条：槽宽必须真的变窄。
   *
   * 只断言 CSS 里写了 `::-webkit-scrollbar` 是没用的 ——
   * 那条规则可能因为选择器写错而完全没生效（开发机上还看不出来，
   * 因为 Chromium 就是唯一在跑的引擎）。
   * 客观判据是**实际占位**：offsetWidth - clientWidth 就是滚动条槽宽，
   * Windows 原生滚动条约 17px，细滚动条应 ≤ 10px。
   */
  const scrollbarFacts = await evaluate(`(() => {
    const bar = (n) => (n ? n.offsetWidth - n.clientWidth : -1);
    return {
      doc: bar(document.documentElement),
      scroller: bar(document.querySelector('.cm-scroller')),
      viewBody: bar(document.querySelector('.view-body')),
      // 工具栏必须仍然是"完全隐藏"，而不是被全局 thin 规则改成细条
      toolbarScrollbarWidth: getComputedStyle(document.querySelector('.toolbar')).scrollbarWidth,
    };
  })()`);
  console.log('滚动条事实：', JSON.stringify(scrollbarFacts));

  const barProblems = [];
  for (const [name, width] of Object.entries({
    文档: scrollbarFacts.doc,
    编辑器: scrollbarFacts.scroller,
    侧栏: scrollbarFacts.viewBody,
  })) {
    // -1 = 该元素此刻没有滚动条（内容不够长），这一项跳过而不是判失败
    if (width >= 0 && width > 10) {
      barProblems.push(`${name}滚动条占 ${width}px，仍是系统粗滚动条（应为 ≤ 10px）`);
    }
  }
  if (scrollbarFacts.toolbarScrollbarWidth !== 'none') {
    barProblems.push(
      `工具栏的横向滚动条变成了 "${scrollbarFacts.toolbarScrollbarWidth}"（应为 none）`,
    );
  }
  if (barProblems.length > 0) {
    for (const p of barProblems) console.log('  ✗ ' + p);
    code = 1;
  } else {
    console.log('滚动条已细化，工具栏横向滚动条仍隐藏');
  }

  /*
   * 12) 文件树与大��的折叠。
   *
   * 断言要点：箭头必须**真的存在**（原来没有任何视觉暗示，用户不知道
   * 哪行能展开）；无子节点的行不能有箭头（否则整棵树都是三角）；
   * 点父节点要真的收起子节点。
   */
  const outlineRows = await evaluate(`(() =>
    [...document.querySelectorAll('.tree-item--outline')].map((r) => ({
      text: r.querySelector('.tree-item__label')?.textContent ?? '',
      expandable: !!r.querySelector('.tree-item__twisty:not(.tree-item__twisty--leaf)'),
      expanded: r.getAttribute('aria-expanded'),
    }))
  )()`);
  console.log('\n大纲折叠：', JSON.stringify(outlineRows));

  const foldProblems = [];
  if (outlineRows.length === 0) {
    foldProblems.push('大纲里没有任何标题行（折叠断言会恒真，先确认文档写进去了）');
  } else {
    // 一级标题有子节点 → 必须有箭头且 aria-expanded=true
    const root = outlineRows[0];
    if (!root.expandable) foldProblems.push(`一级标题「${root.text}」有子节点却没有折叠箭头`);
    if (root.expanded !== 'true' && root.expanded !== 'false') {
      foldProblems.push(`一级标题缺aria-expanded（实际 ${root.expanded}）—— 折叠状态对读屏不可见`);
    }
    // 末行若无子节点则不应有箭头
    const leaf = outlineRows[outlineRows.length - 1];
    if (leaf.expandable && leaf.text !== root.text) {
      foldProblems.push(`末行「${leaf.text}」没有子节点却有折叠箭头（箭头会误导用户）`);
    }

    /*
     * 真点一次：子节点必须消失。
     *
     * ⚠️ 必须点**箭头**，不能点整行。
     *
     * 交互已经拆成两个落点：箭头管折叠、整行管跳转（跳到那个标题）。
     * 早先这条断言用的是 `row.click()` —— 那时整行点击正好等于折叠，
     * 所以能过；语义一改，它点的就是"跳转"了，断言会指着错误的行为。
     * **断言必须跟着交互契约走，不能跟着实现里的某个落点走。**
     */
    const clickOutlineTwisty = (index) => evaluate(`(() => {
      const row = document.querySelectorAll('.tree-item--outline')[${index}];
      if (!row) return 'NO_ROW';
      const tw = row.querySelector('.tree-item__twisty:not(.tree-item__twisty--leaf)');
      if (!tw) return 'NO_TWISTY';
      tw.click();
      return 'clicked';
    })()`);

    const beforeCount = outlineRows.length;
    const foldHit = await clickOutlineTwisty(0);
    if (foldHit !== 'clicked') {
      foldProblems.push(`点不到一级标题的折叠箭头（${foldHit}）`);
    }
    await sleep(700);
    const afterCount = await evaluate(`document.querySelectorAll('.tree-item--outline').length`);
    if (afterCount >= beforeCount) {
      foldProblems.push(`点箭头没有收起子节点（${beforeCount} → ${afterCount}）`);
    }
    // 再点回来
    await clickOutlineTwisty(0);
    await sleep(700);
    const restored = await evaluate(`document.querySelectorAll('.tree-item--outline').length`);
    if (restored !== beforeCount) {
      foldProblems.push(`再次点箭头没有展开回来（${beforeCount} → ${restored}）—— 折叠必须是双向的`);
    }

    /*
     * 点箭头**不该**跳转。
     *
     * 这两个动作共用一个祖先元素，全靠 `stopPropagation` 分开；
     * 少了它，"点箭头"会变成折叠 + 跳转一起发生 —— 而且看起来
     * 还挺"正常"，只有光标位置能戳穿。
     */
    const cursorBefore = await evaluate(`(() => {
      const ls = [...document.querySelectorAll('.cm-line')];
      return ls.findIndex((l) => l.classList.contains('cm-activeLine'));
    })()`);
    await clickOutlineTwisty(0);
    await sleep(600);
    const cursorAfterFold = await evaluate(`(() => {
      const ls = [...document.querySelectorAll('.cm-line')];
      return ls.findIndex((l) => l.classList.contains('cm-activeLine'));
    })()`);
    if (cursorAfterFold !== cursorBefore) {
      foldProblems.push(
        `点折叠箭头却把光标从第 ${cursorBefore} 行挪到了第 ${cursorAfterFold} 行` +
          ' —— 少了 stopPropagation，折叠和跳转一起发生了',
      );
    }
    await clickOutlineTwisty(0); // 复原
    await sleep(600);

    /*
     * 点**文字**必须跳到那个标题。
     *
     * 这条是用户报的缺陷："点击节点不会跳转"。当时的实现是
     * "有子节点就折叠、没有才跳转"，于是只要标题带下级就永远跳不过去。
     * 断言要点在 label 上，并核对光标真的落到了那一条对应的行。
     */
    const jumpFacts = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // 取一个有子节点的条目（正是过去点不动的那些）与它的标题文本
      const rows = [...document.querySelectorAll('.tree-item--outline')];
      const target = rows.find((r) => r.getAttribute('aria-expanded') !== null);
      if (!target) return { error: '没有带子节点的标题，断言会恒真' };
      const label = target.querySelector('.tree-item__label');
      if (!label) return { error: '大纲行没有 label 元素' };
      const text = (label.textContent || '').trim();
      // 先折叠，确认"折叠状态下点文字也能跳"
      const tw = target.querySelector('.tree-item__twisty:not(.tree-item__twisty--leaf)');
      if (tw && target.getAttribute('aria-expanded') === 'true') { tw.click(); await sleep(500); }
      label.click();
      await sleep(600);
      const ls = [...document.querySelectorAll('.cm-line')];
      const active = ls.findIndex((l) => l.classList.contains('cm-activeLine'));
      return { text, active, activeText: active >= 0 ? ls[active].textContent : null };
    })()`);
    console.log('大纲跳转事实：', JSON.stringify(jumpFacts));
    if (jumpFacts.error) {
      foldProblems.push(jumpFacts.error);
    } else if (jumpFacts.active < 0) {
      foldProblems.push('点击大纲文字后编辑器里没有活动行 —— 没有跳转');
    } else if (!(jumpFacts.activeText ?? '').includes(jumpFacts.text.slice(0, 4))) {
      foldProblems.push(
        `点大纲「${jumpFacts.text}」跳到了「${jumpFacts.activeText}」（第 ${jumpFacts.active} 行）—— 落点不对`,
      );
    }
  }
  if (foldProblems.length > 0) {
    for (const p of foldProblems) console.log('  ✗ ' + p);
    code = 1;
  } else {
    console.log('大纲正常（箭头折叠 / 点箭头不跳 / 点文字跳到对应行）');
  }

  /*
   * 13) 文件树箭头：有工作区时目录行必须可展开。
   *
   * 未打开工作区时文件树是空态，所以这条只在有目录时断言 ——
   * 没内容就跳过，而不是把"没数据"判成失败。
   */
  const treeFacts = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.tree-item:not(.tree-item--outline)')];
    return {
      total: rows.length,
      dirs: rows.filter((r) => r.querySelector('.tree-item__twisty:not(.tree-item__twisty--leaf)')).length,
      // 目录名后面不该再有斜杠了（有了箭头和缩进后是纯噪音）
      withSlash: rows.filter((r) => (r.querySelector('.tree-item__label')?.textContent ?? '').endsWith('/')).length,
    };
  })()`);
  console.log('\n文件树：', JSON.stringify(treeFacts));
  if (treeFacts.withSlash > 0) {
    console.log(`  ✗ 有 ${treeFacts.withSlash} 行目录名还带着尾斜杠（有了箭头就是噪音）`);
    code = 1;
  } else {
    console.log('文件树目录名不再带尾斜杠');
  }

  // ── 头部不该再有品牌标记 ────────────────────────────────────
  //
  // 这里原来断言的是"logo 必须加载出来"。现在产品上把它删了
  // （桌面标题栏已有软件名，logo.svg 是 3.2KB 的常驻资源）。
  // 断言随之反向：**它必须不在**。
  //
  // 反向断言同样要防恒真 —— 如果只写"没有报错"，删干净了和
  // 根本没查过会长得一模一样。所以这里明确读两个类名。
  const brand = await evaluate(`(() => ({
    logo: !!document.querySelector('.app-logo'),
    brand: !!document.querySelector('.app-brand'),
    headerText: document.querySelector('.app-header')?.textContent?.trim() ?? '',
    // 侧栏开关是布局开关，不该跟着品牌标记一起被删掉
    sidebarToggle: !!document.querySelector('.app-header button[aria-label="切换侧栏"]'),
  }))()`);
  console.log('\nn头部：', JSON.stringify(brand));
  if (brand.logo || brand.brand) {
    console.log('  ✗ 头部仍有品牌标记（.app-logo / .app-brand），应已删除');
    code = 1;
  } else if (!brand.sidebarToggle) {
    console.log('  ✗ 侧栏开关不见了 —— 它是布局开关，不该跟着品牌标记一起删');
    code = 1;
  } else {
    console.log('头部品牌标记已移除，侧栏开关仍在');
  }

  // ── 分栏预览面板已整体移除 ────────────────────────────────────
  //
  // 旧契约（开面板 → 编辑区切源码 → 恢复）整段作废：用户明确要求
  // 编辑区永远是 Typora 式实时渲染，预览窗与它的 Ctrl+Shift+V 入口
  // 一起删掉。下面断言的是"真的删干净了"——
  // 只删按钮、把面板留在那儿是最容易发生的那种半吊子。
  const previewGone = await evaluate(`(() => ({
    rightColumn: !!document.querySelector('.view-column--right'),
    resizer: !!document.querySelector('.preview-resizer'),
    toolbarBtn: [...document.querySelectorAll('.toolbar button')]
      .some((b) => (b.getAttribute('aria-label') || '').includes('预览')),
  }))()`);
  const previewMode = await modeNow();
  if (previewMode.includes('aropyt-source-mode')) {
    code = 1;
    console.log(`  ✗ 编辑区初始不在渲染态（根节点类：${previewMode}）—— 应始终是 Typora 式渲染`);
  } else if (previewGone.rightColumn || previewGone.resizer || previewGone.toolbarBtn) {
    code = 1;
    console.log('  ✗ 分栏预览面板没删干净：' + JSON.stringify(previewGone));
  } else {
    console.log('分栏预览面板已彻底移除，编辑区始终 Typora 式渲染');
  }

  // Ctrl+Shift+V 也不再有任何作用（面板不存在了，快捷键是遗留残留）
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'V', ctrlKey: true, shiftKey: true, bubbles: true,
  }))`);
  await sleep(600);
  const afterShortcut = await evaluate(`(() => ({
    rightColumn: !!document.querySelector('.view-column--right'),
    mode: document.querySelector('.cm-editor')?.className ?? '',
  }))()`);
  if (afterShortcut.rightColumn) {
    code = 1;
    console.log('  ✗ Ctrl+Shift+V 仍能开出预览面板（快捷键是遗留残留）');
  } else if (!afterShortcut.mode.includes('aropyt-render-mode')) {
    code = 1;
    console.log(`  ✗ 触发快捷键后编辑区离开了渲染态（${afterShortcut.mode}）`);
  } else {
    console.log('Ctrl+Shift+V 已无残留效果');
  }

  /*
   * 侧栏面板的折叠。
   *
   * 需求是"由用户决定只看文件还是只看大纲"，所以断言不能只判
   * "点了 aria-expanded 变了"——那只说明状态翻转了，说明不了
   * 界面真的让出了空间。三层都要测：
   *   1. 折叠后该面板只剩标题栏（高度塌到 30px 上下）
   *   2. **另一个面板的高度变大**（空间真的让过去了）
   *   3. 内容仍在 DOM 里（只隐藏不卸载，展开后插件状态还在）
   * 再加两条容易漏的：持久化（下次启动记得住）与箭头方向。
   */
  const collapseFacts = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const headers = () => [...document.querySelectorAll('.view-header')];
    const snap = () => headers().map((h) => {
      const view = h.parentElement;
      const body = view.querySelector('.view-body');
      const tw = h.querySelector('.twisty');
      return {
        title: h.textContent.trim(),
        expanded: h.getAttribute('aria-expanded'),
        viewH: Math.round(view.getBoundingClientRect().height),
        bodyH: body ? Math.round(body.getBoundingClientRect().height) : -1,
        bodyChildren: body ? body.childElementCount : -1,
        transform: tw ? getComputedStyle(tw).transform : null,
        collapsedClass: view.classList.contains('view--collapsed'),
      };
    });

    const inSidebar = headers().filter((h) => h.closest('.view-column--left'));
    if (inSidebar.length < 2) return { error: '侧栏面板少于 2 个，折叠断言会恒真' };

    const first = inSidebar[0];
    const firstTitle = first.textContent.trim();
    const before = snap();
    first.click();
    await sleep(450);
    const collapsed = snap();
    let stored = null;
    try { stored = localStorage.getItem('aropyt.viewColumn.collapsed.sidebar'); } catch (e) { stored = 'ERR'; }
    // 点回来
    headers().find((h) => h.textContent.trim() === firstTitle).click();
    await sleep(450);
    const restored = snap();
    return { firstTitle, before, collapsed, stored, restored };
  })()`);
  console.log('面板折叠事实：', JSON.stringify(collapseFacts));

  const collapseProblems = [];
  if (collapseFacts.error) {
    collapseProblems.push(collapseFacts.error);
  } else {
    const idx = collapseFacts.before.findIndex((v) => v.title === collapseFacts.firstTitle);
    const b = collapseFacts.before[idx];
    const c = collapseFacts.collapsed[idx];
    const r = collapseFacts.restored[idx];
    const otherIdx = collapseFacts.before.findIndex(
      (v, i) => i !== idx && v.viewH > 0,
    );
    const otherB = otherIdx >= 0 ? collapseFacts.before[otherIdx] : null;
    const otherC = otherIdx >= 0 ? collapseFacts.collapsed[otherIdx] : null;

    if (c.expanded !== 'false') {
      collapseProblems.push(`折叠「${collapseFacts.firstTitle}」后 aria-expanded 是 ${c.expanded}`);
    }
    if (c.viewH > 40) {
      collapseProblems.push(
        `折叠后「${collapseFacts.firstTitle}」仍占 ${c.viewH}px（应只剩约 28px 的标题栏）` +
          ' —— 多半是 .view--collapsed 没让 flex 收缩',
      );
    }
    if (!c.collapsedClass) collapseProblems.push('折叠后没有加上 view--collapsed 类');
    if (c.bodyChildren === 0) {
      collapseProblems.push('折叠把面板内容卸载了 —— 展开后插件状态会丢失');
    }
    if (otherB && otherC && otherC.viewH <= otherB.viewH) {
      collapseProblems.push(
        `折叠「${collapseFacts.firstTitle}」后另一个面板没有变高` +
          `（${otherB.viewH} → ${otherC.viewH}）—— 空间没有让出去`,
      );
    }
    if (r.viewH !== b.viewH) {
      collapseProblems.push(
        `再点一次没有恢复原高度（${b.viewH} → ${r.viewH}）—— 折叠必须双向`,
      );
    }
    // 箭头方向：展开朝下（rotate 90° ≈ matrix(0,1,-1,0,0,0)），折叠朝右（none）
    if (b.transform === c.transform) {
      collapseProblems.push('折叠前后箭头方向没有变化 —— 用户看不出当前是展开还是收起');
    }
    /*
     * 持久化的判据用"非空数组"，不能拿标题去 includes ——
     * 存进去的是**视图 id**（如 `aropyt.explorer`），
     * 而这里拿到的是标题（"文件"），永远匹配不上，
     * 那条断言会恒红，跑久了就没人看了。
     */
    let storedIds = null;
    try { storedIds = JSON.parse(collapseFacts.stored ?? 'null'); } catch { storedIds = null; }
    if (!Array.isArray(storedIds) || storedIds.length === 0) {
      collapseProblems.push(
        `折叠状态没有落到偏好里（storage=${collapseFacts.stored}）—— 下次启动记不住`,
      );
    }
  }
  if (collapseProblems.length > 0) {
    for (const p of collapseProblems) console.log('  ✗ ' + p);
    code = 1;
  } else {
    console.log('侧栏面板折叠正常（只剩标题栏 / 空间让给另一个 / 内容未卸载 / 双向 / 已持久化）');
  }

  // 复位到渲染态，别影响后面的浅色截图
  await clickByLabel('退出源码模式');
  await sleep(700);

  // ── 状态栏不得出现无信息量的条目 ────────────────────────────
  //
  // 「插件 4/4」（全内置基础功能）会让人去找插件商店；
  // 「预算超支 N 次」在冷启动必然触发一次，属于噪声。
  // 两条都是"看起来在报问题、实际什么也没说"的条目。
  const status = await evaluate(`(() => ({
    text: document.querySelector('.status-bar')?.textContent?.trim() ?? '',
    pluginCount: /插件\\s*\\d/.test(document.querySelector('.status-bar')?.textContent ?? ''),
    budgetWording: (document.querySelector('.status-bar')?.textContent ?? '').includes('预算超支'),
    // 输入延迟必须一直在（那是真有信息量的指标）
    hasLatency: (document.querySelector('.status-bar')?.textContent ?? '').includes('输入延迟'),
  }))()`);
  console.log('\nn状态栏：', JSON.stringify(status));
  const statusProblems = [];
  if (status.pluginCount) statusProblems.push('状态栏仍显示「插件 N/M」这类无意义计数');
  if (status.budgetWording) statusProblems.push('状态栏仍显示「预算超支」这种没说清对象的计数');
  if (!status.hasLatency) statusProblems.push('状态栏丢了「输入延迟」（唯一有信息量的性能指标）');
  if (statusProblems.length > 0) {
    for (const p of statusProblems) console.log('  ✗ ' + p);
    code = 1;
  } else {
    console.log('状态栏只保留有信息量的条目');
  }

  // ── 9) 浅色模式 ──────────────────────────────────────────
  //
  // 主题按钮是三态循环（浅色 → 深色 → 跟随系统），所以点击次数不固定。
  // 这里循环点到 data-theme 变成 light 为止，最多点 4 次。
  let themeClicks = 0;
  for (; themeClicks < 4; themeClicks += 1) {
    const nowTheme = await evaluate(`document.documentElement.getAttribute('data-theme')`);
    if (nowTheme === 'light') break;
    await evaluate(`document.querySelector('button[aria-label^="主题"]')?.click(); 'ok'`);
    await sleep(700);
  }
  console.log(`\n切到浅色共点击 ${themeClicks} 次主题按钮`);

  const lightFacts = await evaluate(`(() => {
    const lum = (c) => {
      const m = /rgba?\\((\\d+)[\\s,]+(\\d+)[\\s,]+(\\d+)/.exec(c || '');
      if (!m) return -1;
      return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
    };
    const body = getComputedStyle(document.body);
    const surfaces = [...document.querySelectorAll('.view-column')]
      .map((el) => getComputedStyle(el).backgroundColor);
    // 预览 iframe 的 srcdoc 是**内联**的样式，能直接读出来判断它跟没跟着换色
    const frame = document.querySelector('.preview-frame');
    const srcdoc = frame ? (frame.getAttribute('srcdoc') || '') : '';
    return {
      dataTheme: document.documentElement.getAttribute('data-theme'),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      bodyBg: body.backgroundColor,
      bodyLum: lum(body.backgroundColor),
      textColor: body.color,
      panelBgs: surfaces,
      panelLum: surfaces.map(lum),
      contentMaxWidth: getComputedStyle(document.querySelector('.cm-content')).maxWidth,
      // 深色纸面 #131315（约 0.076 亮度）不该再出现在预览里
      previewLooksDark: srcdoc.includes('#131315') || srcdoc.includes('#1a1a1c'),
      previewHasLightPaper: srcdoc.includes('#ffffff') || srcdoc.includes('rgb(255, 255, 255)'),
      metaColorScheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content'),
    };
  })()`);
  console.log('浅色事实：', JSON.stringify(lightFacts, null, 2));

  const shotC = await rpc('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT_DIR, 'typora-light.png'), Buffer.from(shotC.data, 'base64'));
  console.log('已保存 screenshots/typora-light.png');

  const lightProblems = [];
  if (lightFacts.dataTheme !== 'light') lightProblems.push(`data-theme 应为 light，实际 ${lightFacts.dataTheme}`);
  if (!(lightFacts.bodyLum > 0.85)) lightProblems.push(`浅色下 body 背景不够亮（亮度 ${lightFacts.bodyLum}）`);
  if (lightFacts.panelLum.some((l) => l >= 0 && l < 0.85)) {
    lightProblems.push(`侧栏/面板背景未变浅：${JSON.stringify(lightFacts.panelBgs)}`);
  }
  if (lightFacts.colorScheme !== 'light') lightProblems.push('color-scheme 未跟随（原生滚动条会不协调）');
  if (lightFacts.metaColorScheme !== 'light') lightProblems.push('meta[color-scheme] 未跟随');
  if (lightFacts.previewLooksDark) lightProblems.push('预览 iframe 仍是深色（主题没传过去）');
  if (lightProblems.length > 0) {
    for (const p of lightProblems) console.log('  ✗ ' + p);
    code = 1;
  } else {
    console.log('浅色模式生效，预览已跟随');
  }

  // ── 10) 跟随系统：把系统切回深色，验证 auto 会跟着走 ──
  await rpc('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  // 点到 auto
  for (let i = 0; i < 4; i += 1) {
    const label = await evaluate(
      `document.querySelector('button[aria-label^="主题"]')?.getAttribute('aria-label')`,
    );
    if (String(label).includes('跟随系统')) break;
    await evaluate(`document.querySelector('button[aria-label^="主题"]')?.click(); 'ok'`);
    await sleep(600);
  }
  await sleep(900);
  const autoFacts = await evaluate(`(() => ({
    label: document.querySelector('button[aria-label^="主题"]')?.getAttribute('aria-label'),
    dataTheme: document.documentElement.getAttribute('data-theme'),
  }))()`);
  console.log('模拟系统改深色后：', JSON.stringify(autoFacts));
  if (String(autoFacts.label).includes('跟随系统') && autoFacts.dataTheme !== 'dark') {
    console.log('  ✗ 跟随系统模式下，系统改深色但界面没跟着变');
    code = 1;
  } else if (String(autoFacts.label).includes('跟随系统')) {
    console.log('跟随系统生效');
  }
  ws.close();
} catch (error) {
  console.error('验证失败:', error.message);
  code = 1;
} finally {
  killBrowserTree(chrome);
  server.close();
  await sleep(500);
}

process.exit(code);
