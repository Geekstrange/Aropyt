/**
 * 验证工具栏命令在**原生外壳路径**下能否走通。
 *
 * 为什么不直接开 Tauri 窗口：看不到它的控制台，也截不了图。
 * 但那条路径的关键在于"运行时有没有选对 provider、有没有把参数发对"，
 * 这些可以在浏览器里用**桩**精确验证 —— 提前注入 `__TAURI_INTERNALS__`，
 * 让 capability 层认为自己在原生外壳里，然后检查它到底发了哪些 IPC 调用。
 *
 * 这样测的是**真实代码路径**（runtime → preferredProvider → tauriProvider → IPC），
 * 不是另写一套模拟。
 *
 * 用法：npm run check:commands
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
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
const PORT = 4396;
const CDP_PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * 桩返回的路径常量。
 *
 * 这些值同时用于"桩注入的代码"和"判定端的期望值"，所以只能有一份定义。
 * 以前判定端直接写字面量 'E:////dev////Aropyt-demo'（四个斜杠），
 * 而桩给的是别的形态 —— 两边永远不可能相等，闸门就一直是红的，
 * 而它报的错看起来完全像产品 bug。
 *
 * 注入时用 JSON.stringify 而不是手拼字符串：反斜杠在模板字符串里
 * 还要再转义一层，手拼必错（这就是四个斜杠的来历）。
 */
const DEMO_ROOT = 'E:\\dev\\Aropyt-demo';
const DEMO_FILE_ABS = `${DEMO_ROOT}\\guide.md`;
const DEMO_FILE_REL = 'guide.md';
const IMPORTED_IMAGE = 'assets/photo-1.png';

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
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'aropyt-cmd-'))}`,
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const CDP = `http://127.0.0.1:${CDP_PORT}`;
let code = 0;

try {
  for (let i = 0; ; i += 1) {
    try { if ((await fetch(`${CDP}/json/version`)).ok) break; } catch { /* retry */ }
    if (i > 60) throw new Error('DevTools 未就绪');
    await sleep(400);
  }

  /*
   * 先开**空白页**，注入桩，再导航到应用。
   *
   * 第一版直接开应用 URL，然后在后面调 addScriptToEvaluateOnNewDocument ——
   * 那时页面早已开始执行，桩根本没装上，于是 capability 层仍认为自己在浏览器里，
   * 测试报出一个"看起来像真 bug"的错误。顺序在这里是关键。
   */
  const target = await (
    await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })
  ).json();
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

  /*
   * 关键：在应用脚本执行**之前**装桩。
   * 只桩 invoke，其余保持最小 —— 桩得越少，越接近真实行为。
   * 不存在的命令直接拒绝，好让"忘了在 Rust 侧注册"也暴露出来。
   */
  const STUB = `
    window.__TAURI_CALLS__ = [];
    window.__PICK_FOLDER__ = ${JSON.stringify(DEMO_ROOT)};
    window.__PICK_FILE__ = ${JSON.stringify(DEMO_FILE_ABS)};
    window.__TAURI_INTERNALS__ = {
      invoke: function (command, args) {
        window.__TAURI_CALLS__.push({ command: command, args: args });
        if (command === 'pick_folder') return Promise.resolve(window.__PICK_FOLDER__);
        if (command === 'pick_markdown_file') return Promise.resolve(window.__PICK_FILE__);
        /* 多工作区后必须返回描述符，见 check-tabs.mjs 的说明。 */
        if (command === 'set_workspace') {
          var root = (args && args.root) || '';
          return Promise.resolve({
            id: root,
            name: String(root).split(String.fromCharCode(92)).pop().split('/').pop(),
            root: root,
          });
        }
        if (command === 'workspace_list') {
          var dir = (args && args.args && args.args.path) || '';
          if (dir === '') {
            return Promise.resolve([
              { path: 'guide.md', name: 'guide.md', kind: 'file', size: 12, mtime: 1700000000000 },
              { path: 'notes', name: 'notes', kind: 'directory', size: 0, mtime: 1700000000000 },
              { path: 'readme.txt', name: 'readme.txt', kind: 'file', size: 5, mtime: 1700000000000 },
              { path: 'cover.png', name: 'cover.png', kind: 'file', size: 99, mtime: 1700000000000 },
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
        /*
         * 「打开文件」走的是外部文件通道（不注册工作区）：
         * read_external_file 读、write_external_file 写回原位置。
         */
        if (command === 'read_external_file') return Promise.resolve('');
        if (command === 'write_external_file') return Promise.resolve(null);
        if (command === 'import_image') {
          return Promise.resolve({
            path: ${JSON.stringify(IMPORTED_IMAGE)},
            name: 'photo-1.png',
            bytes: 2048,
          });
        }
        return Promise.reject(new Error('桩未实现的命令：' + command));
      },
    };
  `;
  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await rpc('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(4500);

  const toolbar = () => ev(`(() => {
    const bar = document.querySelector('.toolbar');
    if (!bar) return null;
    return [...bar.querySelectorAll('button')].map((b) => ({
      label: b.getAttribute('aria-label') || b.title || '?',
      // 用图形节点的属性串做指纹，能看出图标内容是否变了
      shape: [...b.querySelectorAll('path,circle,rect,text')]
        .map((n) => (n.getAttribute('d') || n.getAttribute('cx') || n.textContent || '').slice(0, 18))
        .join('|'),
    }));
  })()`);

  /*
   * 提示必须连**级别**一起读出来。
   *
   * 只看"有没有提示文字"是不够的：保存失败时也有提示（"保存失败：guide.md"），
   * 于是"必须有反馈"这条断言会放行一次彻底失败的保存 ——
   * 真机上就是"点了保存，看起来有反应，其实一个字节都没写出去"。
   * 级别写在 class 上，不写在文本里，所以只能从 class 取。
   */
  const toast = () => ev(`(() => {
    const el = document.querySelector('.toast');
    if (!el) return null;
    const level = el.classList.contains('toast--error')
      ? 'error'
      : el.classList.contains('toast--warning')
        ? 'warning'
        : 'info';
    return { text: el.textContent ?? '', level: level };
  })()`);
  const dismiss = () => ev(`(() => { document.querySelectorAll('.toast').forEach((t) => t.click()); return 'ok'; })()`);

  console.log('环境探测：', JSON.stringify(await ev(`(() => ({
    tauriStubActive: typeof window.__TAURI_INTERNALS__ === 'object',
    stubCalls: window.__TAURI_CALLS__.length,
  }))()`)));

  const before = await toolbar();
  console.log('\n点击前工具栏按钮数：', before?.length ?? 0);

  const results = [];

  /*
   * 点击顺序就是用户操作的顺序：先有工作区，再打开文件，再改，最后保存。
   * 保存排在最后，才能真正验到"写出去的内容包含刚插入的图片"，
   * 否则保存的永远只是一份空文档，断言形同虚设。
   */
  for (const label of ['打开文件夹…', '打开文件…', '插入图像', '保存']) {
    logs.length = 0;
    console.log(`\n=== 点击「${label}」 ===`);

    /*
     * 只取**这次点击**产生的 IPC，而不是整个数组。
     *
     * 以前读的是全程累积的调用表，于是"打开文件夹有没有发 set_workspace"
     * 实际上是在问"后面任何一步有没有发过" —— 那根本不是同一个问题，
     * 顺序一变结论就跟着变。
     */
    const start = await ev('window.__TAURI_CALLS__.length');

    /*
     * 精确匹配而不是 includes：「打开文件」是「打开文件夹」的子串，
     * 用 includes 会点错按钮 —— 这次的失败正是这么来的
     * （测试以为点了"打开文件"，实际点的是"打开文件夹"）。
     */
    const hit = await ev(`(() => {
      const btns = [...document.querySelectorAll('.toolbar button')];
      const b = btns.find((x) => (x.getAttribute('aria-label') || x.title || '') === ${JSON.stringify(label)});
      if (!b) {
        return 'NOT_FOUND:' + btns.map((x) => x.getAttribute('aria-label') || x.title).join(',');
      }
      b.click();
      return 'clicked';
    })()`);
    if (hit !== 'clicked') { console.log('未找到按钮：', hit); continue; }

    await sleep(1600);
    const t = await toast();
    const calls = await ev(`window.__TAURI_CALLS__.slice(${start})`);
    console.log('提示：', JSON.stringify(t));
    console.log('  等级：', t?.level ?? '(无提示)');
    console.log('本次 IPC：', JSON.stringify(calls.map((c) => ({ c: c.command, a: c.args?.args ?? c.args }))));
    console.log('控制台：', logs.length ? logs.slice(0, 4).join('\n           ') : '(无)');

    const after = await toolbar();
    const changed = before
      .map((b, i) => ({ label: b.label, was: b.shape, now: after?.[i]?.shape }))
      .filter((d) => d.was !== d.now);
    console.log('图标变化：', changed.length === 0 ? '(无)' : JSON.stringify(changed, null, 2));

    results.push({ label, toast: t, calls, iconChanges: changed.length });
    await dismiss();
    await sleep(400);
  }

  // ── 插入图像必须真的写进编辑器 ──
  //
  // 只断言"命令没报错"是不够的：导入成功但语法没插进去，
  // 或者插成了错误的路径，用户看到的都是"点了没反应"。
  console.log('\n=== 编辑器内容 ===');
  const imageFacts = await ev(`(() => {
    const text = document.querySelector('.cm-content')?.textContent ?? '';
    return {
      editorText: text,
      // 用字符串判断而不是正则：这段代码本身嵌在模板字符串里，
      // 正则的方括号/反斜杠要转两层，非常容易写错（第一次就写错了，
      // 结果是表达式抛异常、断言读到 undefined）。
      hasImageSyntax: text.includes('](${IMPORTED_IMAGE})'),
      // alt 应回退成去掉扩展名的文件名
      alt: (() => {
        const start = text.indexOf('![');
        if (start < 0) return null;
        const end = text.indexOf(']', start);
        return end < 0 ? null : text.slice(start + 2, end);
      })(),
    };
  })()`);
  console.log(JSON.stringify(imageFacts, null, 2));

  // ── 文件树必须显示 markdown 文件 ──
  //
  // 用户报过"选了一个全是 .md 的目录，一个匹配项都没有"。
  // 只断言"命令没报错"是不够的 —— 命令成功但树是空的，功能同样不可用。
  console.log('\n=== 文件树 ===');
  const tree = await ev(`(() => {
    /*
     * 必须限定到「文件」那一个视图。
     * 页面上还有大纲视图，它也有 .view-empty 且文案是"当前文档还没有标题"——
     * 不加限定时读到的可能是它，于是"文件树为空"这条断言
     * 会拿着一句毫不相干的文案去报错（现在不会，但不加就一定会被误导）。
     */
    const section = [...document.querySelectorAll('section.view')].find((s) =>
      (s.querySelector('.view-header')?.textContent ?? '') === '文件',
    );
    if (!section) return { count: -1, labels: [], emptyText: null, missing: true };
    const rows = [...section.querySelectorAll('.tree-item')];
    return {
      count: rows.length,
      labels: rows.map((r) => r.textContent),
      emptyText: section.querySelector('.view-empty')?.textContent ?? null,
    };
  })()`);
  console.log(JSON.stringify(tree, null, 2));

  /*
   * 存一张截图。
   *
   * "断言全过"证明不了"看起来对" —— 这是本项目踩过的最贵的一课
   * （check:render 10 条断言全绿时渲染根本没生效）。
   * 既然这个闸门已经把工作区、文件树、编辑器都摆好了，
   * 顺手留下一张人眼可查的图，成本几乎为零。
   */
  const SHOT = resolve('screenshots/native-file-tree.png');
  mkdirSync(resolve('screenshots'), { recursive: true });
  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log('已保存', SHOT);

  console.log('\n=== 判定 ===');
  const problems = [];
  const byLabel = (label) => results.find((r) => r.label === label);
  const has = (label, command) => (byLabel(label)?.calls ?? []).some((c) => c.command === command);
  const argsOf = (label, command) => byLabel(label)?.calls.find((c) => c.command === command)?.args;

  /*
   * 错误判定按**等级**，不按文案里有没有"失败"两个字。
   * 文案会改、会本地化、会有措辞不同的同义表达，等级不会。
   */
  for (const r of results) {
    if (r.toast?.level === 'error') {
      problems.push(`${r.label} 报了错误级提示：${r.toast.text.replace(/\n/g, ' / ')}`);
    }
  }

  // 「打开文件夹」：必须走原生选择器，并把根登记到后端
  if (!has('打开文件夹…', 'pick_folder')) {
    problems.push('「打开文件夹」没有调用原生的 pick_folder —— 说明没走 tauriProvider');
  }
  if (!has('打开文件夹…', 'set_workspace')) {
    problems.push('「打开文件夹」选完没有调用 set_workspace —— 工作区没在后端登记');
  }
  const folderRoot = argsOf('打开文件夹…', 'set_workspace')?.root;
  if (folderRoot !== DEMO_ROOT) {
    problems.push(`打开文件夹后工作区根应为 ${DEMO_ROOT}，实际 ${JSON.stringify(folderRoot)}`);
  }

  /*
   * 「打开文件」：以**外部文件**身份打开，**不**注册工作区。
   *
   * 这条以前断言"工作区 = 文件所在目录" —— 那正是用户要求改掉的行为：
   * 顺手把父目录变成项目，文件树会多出一堆没要求打开的兄弟文件，
   * 目录还会被持久化、下次启动自动恢复。
   */
  if (!has('打开文件…', 'pick_markdown_file')) {
    problems.push('「打开文件」没有调用原生的 pick_markdown_file');
  }
  if (has('打开文件…', 'set_workspace')) {
    problems.push('「打开文件」不应该把父目录注册成工作区');
  }
  const extRead = argsOf('打开文件…', 'read_external_file')?.path;
  if (extRead !== DEMO_FILE_ABS) {
    problems.push(`打开文件应以绝对路径读取 ${DEMO_FILE_ABS}，实际 ${JSON.stringify(extRead)}`);
  }

  // 「插入图像」
  const importArgs = argsOf('插入图像', 'import_image')?.args;
  if (!importArgs) {
    problems.push('「插入图像」没有调用原生的 import_image');
  } else if (importArgs.targetDir !== 'assets') {
    problems.push(`导入目标目录应为 assets，实际 ${JSON.stringify(importArgs)}`);
  }
  if (!imageFacts.hasImageSyntax) {
    problems.push(`编辑器里没有出现正确的图片语法，实际文本：「${imageFacts.editorText}」`);
  }
  if (imageFacts.alt !== 'photo-1') {
    problems.push(`没有选中文字时 alt 应为去掉扩展名的文件名，实际「${imageFacts.alt}」`);
  }

  /*
   * 「保存」：必须真的把当前内容写到刚打开的那个文件。
   *
   * 不检查"有没有提示"就够了 —— 写出去的内容不对时同样不报错，
   * 用户要等下次打开才发现东西没了。
   */
  /* 打开的是外部文件 → 保存走 write_external_file，写回原绝对路径 */
  const writeArgs = argsOf('保存', 'write_external_file');
  if (!writeArgs) {
    problems.push('「保存」没有调用原生的 write_external_file —— 点了保存但没落盘');
  } else {
    if (writeArgs.path !== DEMO_FILE_ABS) {
      problems.push(`保存应写回 ${DEMO_FILE_ABS}，实际写向 ${JSON.stringify(writeArgs.path)}`);
    }
    if (typeof writeArgs.text !== 'string' || !writeArgs.text.includes(`](${IMPORTED_IMAGE})`)) {
      problems.push(
        `保存的内容应与编辑器一致（含刚插入的图片），实际「${JSON.stringify(writeArgs.text)}」`,
      );
    }
  }
  const saveToast = byLabel('保存')?.toast;
  if (!saveToast) {
    problems.push('「保存」没有任何反馈 —— 用户无法区分"保存了"和"没反应"');
  } else if (!saveToast.text.includes('已保存')) {
    problems.push(`「保存」的反馈不是成功提示，实际「${saveToast.text}」`);
  }

  if (tree.missing) {
    problems.push('页面上找不到「文件」视图 —— 视图槽位或激活链路断了');
  } else if (tree.count < 3) {
    problems.push(
      `文件树只渲染出 ${tree.count} 项（期望 ≥3：guide.md / notes/ / notes/todo.md / readme.txt）。` +
        (tree.emptyText ? ` 视图提示：「${tree.emptyText}」` : ''),
    );
  }
  if (!tree.labels?.some((l) => l.includes('guide.md'))) {
    problems.push('文件树里没有 guide.md —— 根目录没有被列举');
  }
  if (!tree.labels?.some((l) => l.includes('notes/todo.md') || l.includes('todo.md'))) {
    problems.push('子目录没有被递归展开 —— 目录条目可能没被识别为 directory');
  }
  if (tree.labels?.some((l) => l.includes('cover.png'))) {
    problems.push('非 markdown 文件被显示了（cover.png 不该出现）');
  }

  if (problems.length > 0) {
    for (const p of problems) console.log('  ✗ ' + p);
    code = 1;
  } else {
    console.log('命令链在原生外壳路径下全部走通（打开 → 编辑 → 保存）');
  }

  ws.close();
} catch (e) {
  console.error('诊断失败:', e.message);
  code = 1;
} finally {
  killBrowserTree(chrome);
  server.close();
  await sleep(400);
}
process.exit(code);
