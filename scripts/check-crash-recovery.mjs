/**
 * 崩溃恢复日志的闸门。
 *
 * ── 为什么值得单独一个脚本 ──────────────────────────────────
 * "文件即真理"是这个产品的底线，而崩溃恢复日志是唯一能**覆盖磁盘内容**
 * 的东西 —— 它一旦判错，用户看到的就是"文件内容货不对板"。
 * 这条链路出过的两个真事故：
 *
 *   1. 判据缺失。注释写着"如果草稿比磁盘上的内容新"，代码却只判了
 *      `draft.text !== content` —— 于是任何一份残留草稿（哪怕比文件还旧）
 *      都会覆盖磁盘内容。
 *   2. `openFile` 里先换文档、后设 activePath。而换文档会触发 onDocChange
 *      写草稿，此刻 activePath 还是**上一个文件** —— 打开 B 会把 B 的内容
 *      写成 A 的草稿，下次打开 A 就串了。
 *
 * 两次都不是"功能没写"，而是"判据写歪了"，静态断言看不出来，
 * 必须真的走一遍 打开 → 编辑 → 保存 → 再打开。
 *
 * 用法：npm run check:crash
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
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
const PORT = 4417;
const CDP_PORT = 9356;

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
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'aropyt-crash-'))}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = `http://127.0.0.1:${CDP_PORT}`;

/** 磁盘上的那份文件的 mtime。测试里要能随手改，用来构造"过期草稿"。 */
const FILE_MTIME = 1_700_000_000_000;
const IS_SUPPORTED_AT = 1_700_000_500_000;

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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面内异常');
    return r.result?.value;
  };

  // ── 桩：文件系统 + IPC ──
  //
  // ⚠️ 磁盘状态必须用 `sessionStorage` 持久化。
  //
  // 崩溃恢复的草稿存在 IndexedDB 里，是**跨会话**的 —— 只测单次会话等于
  // 完全没测到"关掉应用再打开"这条路径，而用户报的"没崩溃过却提示崩溃恢复"
  // 恰好就发生在那里。重载页面后 `window` 上的变量会重置，所以磁盘那份
  // 状态得找个能活过重载的地方放。
  const STUB = `
    window.__TAURI_CALLS__ = [];
    var DISK_KEY = '__aropyt_probe_disk__';
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(DISK_KEY) || 'null'); } catch (e) { saved = null; }
    window.__DISK__ = saved || { text: ${JSON.stringify('磁盘上的原始内容。')}, mtime: ${FILE_MTIME}, writes: [] };
    window.__saveDisk__ = function () {
      try { sessionStorage.setItem(DISK_KEY, JSON.stringify(window.__DISK__)); } catch (e) {}
    };
    window.__saveDisk__();
    window.__TAURI_INTERNALS__ = {
      invoke: function (command, args) {
        window.__TAURI_CALLS__.push({ command: command, args: args });
        if (command === 'pick_folder') return Promise.resolve('E:/demo');
        if (command === 'pick_markdown_file') return Promise.resolve('E:/demo/guide.md');
        /*
         * 另存为：返回一个"用户选好的路径"。
         * 桩不弹真对话框，但要如实记录它被问了几次、建议的文件名是什么 ——
         * 这两点正是"未命名文档保存"这条路径上最该被验的东西。
         */
        if (command === 'save_markdown_file') {
          window.__SAVE_DIALOGS__ = window.__SAVE_DIALOGS__ || [];
          /*
           * ⚠️ 这里的参数层级是 args.suggested，**不是** args.args.suggested。
           *
           * invokeAs 只是原样转发（api.invoke(command, args)），
           * 包几层由各调用点自己决定：workspace_write 传 {args:{...}}，
           * 这条传的是 {suggested}。桩不能凭印象套别的命令的形状 ——
           * 读错层级会静默拿到 undefined，看起来像"产品没传出默认文件名"，
           * 实际是探针读歪了（实测就是这么误判的）。
           */
          window.__SAVE_DIALOGS__.push(args && args.suggested ? args.suggested : null);
          return Promise.resolve(window.__SAVE_TARGET__ || 'E:/demo/Untitled.md');
        }
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
          if (dir === '' || dir === 'E:/demo') {
            return Promise.resolve([
              { path: 'guide.md', name: 'guide.md', kind: 'file', size: 10, mtime: window.__DISK__.mtime },
            ]);
          }
          return Promise.resolve([]);
        }
        if (command === 'workspace_read') {
          return Promise.resolve(window.__DISK__.text);
        }
        if (command === 'workspace_write') {
          window.__DISK__.writes.push(args && args.args);
          /*
           * ⚠️ 参数名是 'content' 而不是 'text'。
           *
           * 写错的话桩会"收下一次写入但什么也没改" ——
           * 于是下一次 read 拿到的是旧文本，看起来像"保存没生效"，
           * 而真实原因只是探针读错了字段名。
           * 桩要和真实 provider 的契约逐字对齐（见 capabilities 的 tauri provider）。
           */
          if (args && args.args && typeof args.args.content === 'string') {
            window.__DISK__.text = args.args.content;
            window.__DISK__.mtime = window.__DISK__.mtime + 1000;
          }
          window.__saveDisk__();
          return Promise.resolve(null);
        }
        return Promise.reject(new Error('桩未实现的命令：' + command));
      },
    };
  `;
  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await rpc('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await rpc('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(4500);

  // ── 辅助 ──
  const clickToolbar = async (label) => {
    const hit = await ev(`(() => {
      const btns = [...document.querySelectorAll('.toolbar button')];
      const b = btns.find((x) => (x.getAttribute('aria-label') || x.title || '') === ${JSON.stringify(label)});
      if (!b) return 'NOT_FOUND';
      b.click();
      return 'clicked';
    })()`);
    await sleep(1400);
    return hit === 'clicked';
  };
  /** 读通知栏的提示（崩溃恢复提示会出现在这里）。 */
  const toasts = () => ev(`(() => [...document.querySelectorAll('.toast')].map((t) => ({
    text: (t.textContent || '').trim(),
    level: t.className.includes('toast--error') ? 'error'
      : t.className.includes('toast--warning') ? 'warning' : 'info',
  })))()`);
  const dismissToasts = () => ev(`(() => {
    document.querySelectorAll('.toast').forEach((t) => t.click());
    return 'dismissed';
  })()`);
  const editorText = () => ev(`(() => {
    const el = document.querySelector('.cm-content');
    return el ? el.textContent : null;
  })()`);

  /** 直接操作应用的 IndexedDB（草稿就在这个库里）。 */
  const withDb = (body) => ev(`(async () => {
    const db = await new Promise((res, rej) => {
      /* 不带版本：应用建库时已是 v2，写死 1 会在第二次打开时抛 VersionError */
      const r = indexedDB.open('aropyt');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!db.objectStoreNames.contains('drafts')) { db.close(); return { error: 'no drafts store' }; }
    const out = await (async () => { ${body} })();
    db.close();
    return out;
  })()`);

  const putDraft = (key, text, at) => withDb(`
    return await new Promise((res, rej) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put({ text: ${JSON.stringify(text)}, at: ${at} }, ${JSON.stringify(key)});
      tx.oncomplete = () => res('ok');
      tx.onerror = () => rej(tx.error);
    });
  `);
  const allDrafts = () => withDb(`
    return await new Promise((res, rej) => {
      const tx = db.transaction('drafts', 'readonly');
      const rq = tx.objectStore('drafts').getAll();
      const keys = tx.objectStore('drafts').getAllKeys();
      tx.oncomplete = () => res({ values: rq.result, keys: keys.result });
      tx.onerror = () => rej(tx.error);
    });
  `);

  /*
   * 起始状态必须自己清干净。
   *
   * 草稿是**跨会话**的，而 Chrome 的 IndexedDB 目录并不总能被
   * `--user-data-dir` 完全隔离（实测上一次运行留下的草稿会被读回来）。
   * 不清的话，第一条"打开文件不该产生草稿"的断言会读到上次的残留而失败 ——
   * 看起来像产品回归，其实只是测试没擦桌子。
   *
   * 顺带把"正常退出"标记也清掉：它决定恢复时的措辞，
   * 残留会让措辞断言随机地过或不过。
   */
  await withDb(`return await new Promise((res) => {
    const tx = db.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').clear();
    tx.oncomplete = () => res('cleared');
    tx.onerror = () => res('err');
  });`);
  await ev(`(() => { try { localStorage.removeItem('aropyt.cleanExit'); } catch (e) {} return 'ok'; })()`);

  // ── 0) 未命名文档按保存 = 另存为 ──
  //
  // 刚启动的应用没有打开任何文件（path 为 null），此时按保存**不该**回一句
  // "请先在左侧文件树里点一个 markdown 文件"—— 那是把系统的功能缺口
  // 转嫁给用户。用户只是想把正在写的东西存下来，"存到哪"正是保存
  // 这个动作本该问出来的事。
  await ev(`(() => {
    const el = document.querySelector('.cm-content');
    el.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, '# 我的笔记\\n\\n正文。');
    return 'ok';
  })()`);
  await sleep(900);
  await dismissToasts();
  await clickToolbar('保存');
  await sleep(1400);

  const saveDialogs = await ev(`window.__SAVE_DIALOGS__ || []`);
  const saveCalls = await ev(
    `(window.__TAURI_CALLS__ || []).filter((c) => c.command === 'save_markdown_file').map((c) => c.args)`,
  );
  const writes = await ev(
    `(window.__DISK__.writes || []).map((w) => ({ path: w && w.path, content: w && w.content }))`,
  );
  console.log('\n另存为调用的原始参数：', JSON.stringify(saveCalls));
  console.log('未命名文档保存 → 另存为默认名：', JSON.stringify(saveDialogs));
  console.log('                   写入记录：', JSON.stringify(writes.slice(-1)));
  if (saveDialogs.length === 0) {
    note('未命名文档按保存没有弹出另存为 —— 用户拿不到路径就没法存盘');
  } else if (saveDialogs[0] !== '我的笔记.md') {
    note(
      `另存为的默认文件名是 ${JSON.stringify(saveDialogs[0])}，` +
        '而不是按第一个标题推断出来的「我的笔记.md」',
    );
  } else {
    const last = writes[writes.length - 1];
    if (!last || !String(last.content ?? '').includes('我的笔记')) {
      note(`另存为之后没有把内容写出去：${JSON.stringify(last)}`);
    } else {
      pass('未命名文档按保存 → 另存为并成功落盘');
    }
  }

  // ── 准备：打开工作区与文件 ──
  if (!(await clickToolbar('打开文件夹…'))) {
    note('找不到「打开文件夹…」按钮');
  }
  if (!(await clickToolbar('打开文件…'))) {
    note('找不到「打开文件…」按钮');
  }
  await dismissToasts();
  await sleep(400);

  // ── 1) 打开文件**不该**产生草稿 ──
  //
  // 装载是一次整篇替换，CM6 把它当成普通文档变更。不挡住的话
  // "打开"会被记成一次编辑：文档变脏、并往崩溃日志里写一份与磁盘相同的内容。
  const afterOpen = await allDrafts();
  console.log('\n打开文件后的草稿：', JSON.stringify(afterOpen));
  /*
   * 只看**这个文件**的草稿。
   *
   * `__untitled__` 是未命名文档的草稿槽 —— 上一步确实写了内容给它，
   * 那份草稿是合理的（有未保存内容、又没有路径可存）。
   * 这条断言问的是"打开文件有没有凭空造出草稿"，不该被它干扰。
   */
  const fileDrafts = (afterOpen.keys ?? []).filter((k) => k !== '__untitled__');
  if (afterOpen.error) {
    note(`读不到 drafts 存储：${afterOpen.error}`);
  } else if (fileDrafts.length > 0) {
    note(
      `只是打开文件就产生了 ${fileDrafts.length} 份草稿（key=${JSON.stringify(fileDrafts)}）` +
        ' —— 装载被当成了编辑，下次打开会误报"已恢复未保存内容"',
    );
  } else {
    pass('打开文件没有产生草稿（装载未被当成编辑）');
  }

  // ── 2) 真的编辑之后，草稿必须落在**当前文件**的名下 ──
  await ev(`(() => {
    const el = document.querySelector('.cm-content');
    el.focus();
    document.execCommand('insertText', false, '用户新输入的一行。');
    return 'ok';
  })()`);
  await sleep(1200);

  const afterEdit = await allDrafts();
  console.log('编辑后的草稿：', JSON.stringify(afterEdit));
  const keys = afterEdit.keys ?? [];
  if (keys.length === 0) {
    note('编辑之后没有落草稿 —— 崩溃恢复链路断了');
  } else if (!keys.some((k) => String(k).includes('guide.md'))) {
    note(
      `草稿挂在错误的名下：${JSON.stringify(keys)}（应包含 guide.md）` +
        ' —— 多半是写草稿时 activePath 还指向上一个文件',
    );
  } else {
    pass(`编辑后草稿正确记在 guide.md 名下`);
  }

  // ── 3) 保存必须清掉草稿 ──
  await dismissToasts();
  await clickToolbar('保存');
  await sleep(900);
  const afterSave = await allDrafts();
  console.log('保存后的草稿：', JSON.stringify(afterSave));
  if ((afterSave.keys ?? []).length > 0) {
    note(
      `保存后草稿仍在（key=${JSON.stringify(afterSave.keys)}）` +
        ' —— 多半是没先取消待执行的防抖写入，它在删除之后又把草稿写了回来',
    );
  } else {
    pass('保存后草稿被清掉（且没有被防抖写回）');
  }

  const reloadAndOpen = async (label) => {
    await rpc('Page.reload', { ignoreCache: false });
    await sleep(4000);
    await dismissToasts();
    await clickToolbar('打开文件夹…');
    await clickToolbar('打开文件…');
    await sleep(700);
    const t = await toasts();
    const text = await editorText();
    console.log(`\n[${label}] 重开后打开文件 → 内容：${JSON.stringify(text)}`);
    console.log(`            提示：${JSON.stringify(t)}`);
    return { toasts: t, text };
  };

  // ── 4) **过期**草稿绝不能覆盖磁盘 ──
  //
  // 这是最能造成数据损坏的一条：草稿比文件旧，说明磁盘上的内容更新，
  // 拿旧草稿覆盖它就是"货不对板"。
  await dismissToasts();
  await ev(`window.__DISK__.text = '磁盘上的较新内容。'; window.__DISK__.mtime = ${FILE_MTIME + 60_000}; window.__saveDisk__(); 'set'`);
  /*
   * 草稿键带工作区前缀（多工作区隔离），直接塞裸路径是读不到的。
   * 前缀必须与运行时拿到的 workspace.id 完全一致：`pick_markdown_file`
   * 返回的是正斜杠路径，而 openMarkdownFile 用反斜杠拼父目录 ——
   * Tauri 下两者一致，桩里必须模拟成反斜杠。
   */
  const DRAFT_PREFIX = 'E:\\demo' + String.fromCharCode(0);
  await putDraft(`${DRAFT_PREFIX}guide.md`, '过期的草稿内容（绝不该出现）', FILE_MTIME - 60_000);
  /*
   * 用 reload + 重新打开，而不是"再点一次打开文件"。
   *
   * 有了标签系统之后，**已在标签里的文件不会再重新读盘**
   * （VSCode 也是这个行为，重读会把未保存的修改冲掉）。
   * 这条用例模拟的是"重启应用之后打开"—— reload 清掉内存里的标签，
   * 草稿（IndexedDB）和磁盘状态（sessionStorage）都保留，
   * 才是这条断言真正想考的场景。
   */
  await reloadAndOpen('过期草稿');
  await sleep(400);

  const oldDraftText = await editorText();
  const oldToasts = await toasts();
  console.log('\n过期草稿场景 → 编辑器内容：', JSON.stringify(oldDraftText));
  console.log('                  提示：', JSON.stringify(oldToasts));
  if ((oldDraftText ?? '').includes('过期的草稿')) {
    note('比文件更旧的草稿覆盖了磁盘内容 —— 这正是"文件内容货不对板"的来源');
  } else if (!(oldDraftText ?? '').includes('磁盘上的较新内容')) {
    note(`内容既不是磁盘的也不是草稿的：${JSON.stringify(oldDraftText)}`);
  } else {
    pass('过期草稿被忽略，内容取自磁盘');
  }
  if (oldToasts.some((t) => t.text.includes('崩溃恢复'))) {
    note('用过期草稿时仍然弹了「已从崩溃恢复日志中还原」—— 判据没生效');
  } else {
    pass('过期草稿没有触发恢复提示');
  }

  // ── 5) 而**确实更新**的草稿必须照常恢复（别把功能修坏了）──
  await dismissToasts();
  await ev(`window.__DISK__.text = '磁盘上的旧内容。'; window.__DISK__.mtime = ${FILE_MTIME}; window.__saveDisk__(); 'set'`);
  await putDraft(`${DRAFT_PREFIX}guide.md`, '崩溃前未保存的内容。', FILE_MTIME + 60_000);
  await reloadAndOpen('新草稿');
  await sleep(400);

  const newDraftText = await editorText();
  const newToasts = await toasts();
  console.log('\n新草稿场景 → 编辑器内容：', JSON.stringify(newDraftText));
  console.log('                提示：', JSON.stringify(newToasts));
  if (!(newDraftText ?? '').includes('崩溃前未保存的内容')) {
    note('更新的草稿没有被恢复 —— 崩溃恢复功能被改坏了');
  } else if (!newToasts.some((t) => t.text.includes('恢复') || t.text.includes('还原'))) {
    note('恢复了内容却没有给出提示，用户不知道手上这份不是磁盘上的');
  } else {
    pass('更新的草稿正常恢复，并且给了提示');
  }

  /*
   * 5b) 提示上必须有「丢弃」出口，而且它真的能把内容换回磁盘版本。
   *
   * 此前恢复之后用户只剩一条路：点掉提示，然后自己想办法收拾 ——
   * 而唯一能盖掉这份内容的动作就是"保存"，偏偏他正是不想要它。
   * 更糟的是如果不给出口，这份草稿会一直在，每次打开都提示一遍。
   */
  const discardButton = await ev(`(() => {
    const btns = [...document.querySelectorAll('.toast__action')];
    const b = btns.find((x) => (x.textContent || '').includes('丢弃'));
    if (!b) return null;
    b.click();
    return 'clicked';
  })()`);
  await sleep(1200);
  const afterDiscard = await editorText();
  const draftsAfterDiscard = await allDrafts();
  console.log('\n丢弃之后 → 内容：', JSON.stringify(afterDiscard));
  console.log('           草稿：', JSON.stringify(draftsAfterDiscard));
  if (!discardButton) {
    note('恢复提示上没有「丢弃」按钮 —— 用户不想要这份内容时没有任何出口');
  } else if ((afterDiscard ?? '').includes('崩溃前未保存的内容')) {
    note('点了「丢弃」内容却没换回磁盘版本');
  } else if ((draftsAfterDiscard.keys ?? []).some((k) => String(k).includes('guide.md'))) {
    note('点了「丢弃」草稿还在 —— 下次打开还会再提示一遍，等于没丢');
  } else {
    pass('「丢弃」可用：内容换回磁盘版本，草稿也清掉了');
  }

  // ── 6) **关掉应用再打开**：这是之前完全没测到的路径 ──
  //
  // 草稿存在 IndexedDB 里，是跨会话的。用户报的"我没崩溃过却提示
  // 崩溃恢复"就发生在这里：正常退出时草稿被留着，重开后一打开文件
  // 就走恢复分支。
  //
  // 分两种情况，要求不同：
  //   a. 上次**保存过** → 草稿应当已经清掉 → 重开后什么都不该提示
  //   b. 上次**有未保存的修改** → 恢复是对的，但文案不能说"崩溃恢复"
  //      （用户明明是正常关掉的），否则他会以为文件出了问题

  // a. 保存过之后关掉再打开：不该有任何"恢复"提示
  await dismissToasts();
  await ev(`(() => {
    const el = document.querySelector('.cm-content');
    el.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, '保存过的内容。');
    return 'ok';
  })()`);
  await sleep(900);
  await clickToolbar('保存');
  await sleep(1200);
  console.log('保存后磁盘状态：', JSON.stringify(await ev(`window.__DISK__.text`)));
  console.log('保存后 sessionStorage：', JSON.stringify(await ev(`sessionStorage.getItem('__aropyt_probe_disk__')?.slice(0, 60) ?? null`)));
  const clean = await reloadAndOpen('上次已保存');
  const cleanRestoreToast = clean.toasts.find((t) => t.text.includes('恢复') || t.text.includes('还原'));
  if (cleanRestoreToast) {
    note(
      `上次明明保存过，重开后仍提示「${cleanRestoreToast.text}」` +
        ' —— 保存没有清干净草稿，或者正常退出时草稿没有被回收',
    );
  } else if (!(clean.text ?? '').includes('保存过的内容')) {
    note(`上次保存的内容没读回来：${JSON.stringify(clean.text)}`);
  } else {
    pass('上次保存过 → 重开无恢复提示（干净退出不留草稿）');
  }

  // b. 有未保存修改时关掉：内容该恢复，但措辞不能是"崩溃"
  await dismissToasts();
  await ev(`(() => {
    const el = document.querySelector('.cm-content');
    el.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, '这次故意不保存。');
    return 'ok';
  })()`);
  await sleep(1000);
  const dirty = await reloadAndOpen('上次未保存');
  const dirtyToast = dirty.toasts.find((t) => t.text.includes('恢复') || t.text.includes('还原'));
  if (!(dirty.text ?? '').includes('这次故意不保存')) {
    note(`未保存的修改没有被恢复：${JSON.stringify(dirty.text)} —— 数据丢了`);
  } else if (!dirtyToast) {
    note('恢复了内容却没给任何提示，用户不知道手上这份不是磁盘上的');
  } else if (dirtyToast.text.includes('崩溃')) {
    note(
      `正常关闭后重开，提示却说「${dirtyToast.text}」` +
        ' —— 用户没崩溃过，看到"崩溃恢复"会以为文件坏了。' +
        '正常退出与崩溃必须给不同措辞',
    );
  } else {
    pass('未保存的修改被恢复，且措辞没有谎称"崩溃"');
  }

  /*
   * 7) "只是打开看看" —— 用户报的确切场景。
   *
   * 一个字都没改就不该留下草稿；没有草稿，重开自然不会有任何"恢复"。
   *
   * 这条要在**打开之后立刻**查草稿，而不是只看提示：提示是果、草稿是因，
   * 盯住因才能说清问题出在哪一步。
   */
  await withDb(`return await new Promise((res) => {
    const tx = db.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').clear();
    tx.oncomplete = () => res('cleared');
    tx.onerror = () => res('err');
  });`);
  /*
   * 必须 reload：有了标签之后，guide.md 此刻还在标签里挂着
   * （缓冲区是上一条用例的内容），"再点一次打开文件"只会命中
   * 已存在分支、根本不读盘 —— 那测出来的差异是标签缓冲区的，
   * 不是装载过程的。
   */
  await reloadAndOpen('只打开看看');
  await sleep(400);

  const afterPlainOpen = await allDrafts();
  console.log('\n[只打开看看] 打开后的草稿：', JSON.stringify(afterPlainOpen));

  /*
   * 打开之后，编辑器里的内容必须与磁盘**逐字节相同**。
   *
   * 不等就说明"装载"这条路上内容被改过 —— 而任何一次内容变化都会
   * 触发 onDocChange 去写草稿，于是用户"只打开看看"也会留下
   * 一份"未保存的修改"。这条断言直接盯住那个差值的来源：
   * 是"打开动作写了草稿"还是"打开动作改了内容"，一看便知。
   */
  const diskText = await ev(`window.__DISK__.text`);
  const editorAfterOpen = await editorText();
  console.log('[只打开看看] 磁盘：  ', JSON.stringify(diskText));
  console.log('[只打开看看] 编辑器：', JSON.stringify(editorAfterOpen));
  if (editorAfterOpen !== diskText) {
    note(
      `打开之后编辑器内容与磁盘不一致：磁盘 ${JSON.stringify(diskText)}，` +
        `编辑器 ${JSON.stringify(editorAfterOpen)} —— 装载过程改动了内容，` +
        '它会连带写出一份假的"未保存修改"',
    );
  }

  const strayDrafts = (afterPlainOpen.keys ?? []).filter((k) => k !== '__untitled__');
  if (strayDrafts.length > 0) {
    note(
      `只是打开文件、一个字没改，却留下了草稿 ${JSON.stringify(strayDrafts)}` +
        ' —— 重开时它会被当成"未保存的修改"还原，' +
        '用户看到的就是"我只打开看看，怎么提示恢复了"',
    );
  }

  const plainOpen = await reloadAndOpen('只打开看看');
  const plainToast = plainOpen.toasts.find(
    (t) => t.text.includes('恢复') || t.text.includes('还原'),
  );
  if (plainToast) {
    note(`只打开看看、什么都没改，重开却提示「${plainToast.text}」`);
  } else if (strayDrafts.length === 0) {
    pass('只打开看看 → 不留草稿、重开也无恢复提示');
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
    ? `\n崩溃恢复检查发现 ${problems.length} 个问题`
    : '\n崩溃恢复链路正常（打开不落草稿 / 记对名下 / 保存即清 / 过期不覆盖 / 更新照常恢复）',
);
process.exit(problems.length > 0 ? 1 : 0);
