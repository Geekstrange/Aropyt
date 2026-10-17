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
  const FILES = ['alpha.md', 'beta.md', 'gamma.md'];
  const STUB = `
    window.__TAURI_INTERNALS__ = {
      invoke: function (command, args) {
        if (command === 'pick_folder') return Promise.resolve('E:/demo');
        if (command === 'set_workspace') return Promise.resolve(null);
        if (command === 'workspace_list') {
          var dir = (args && args.args && args.args.path) || '';
          if (dir === '' || dir === 'E:/demo') {
            return Promise.resolve(${JSON.stringify(FILES.map((name) => ({
              path: name, name, kind: 'file', size: 10, mtime: 1700000000000,
            })))});
          }
          return Promise.resolve([]);
        }
        if (command === 'workspace_read') {
          var p = (args && args.args && args.args.path) || '';
          return Promise.resolve('# ' + p + '\\n\\n内容。');
        }
        if (command === 'workspace_write') return Promise.resolve(null);
        return Promise.reject(new Error('桩未实现的命令：' + command));
      },
    };
  `;
  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
  await rpc('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await rpc('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(4500);

  // ── 辅助 ──
  const clickToolbar = async (label) => {
    await ev(`(() => {
      const b = [...document.querySelectorAll('.toolbar button')]
        .find((x) => (x.getAttribute('aria-label') || x.title || '') === ${JSON.stringify(label)});
      if (b) b.click();
      return b ? 'clicked' : 'NOT_FOUND';
    })()`);
    await sleep(1400);
  };
  /** 读标签栏的真实状态（顺序、预览态、激活态）。 */
  const tabs = () => ev(`(() => [...document.querySelectorAll('.tab')].map((t) => ({
    name: (t.querySelector('.tab__label') || {}).textContent || '',
    previewClass: t.className.includes('tab--preview'),
    active: t.className.includes('tab--active'),
    // 斜体是"预览标签"的**视觉**判据 —— 类名对了不等于样式生效
    italic: (() => {
      const l = t.querySelector('.tab__label');
      return l ? getComputedStyle(l).fontStyle === 'italic' : null;
    })(),
    closeButtons: t.querySelectorAll('.tab__close').length,
  })))()`);

  /** 在文件树里单击一个文件（真实鼠标事件，因为要区分单击与双击）。 */
  const clickTreeFile = async (name, { double = false } = {}) => {
    const box = await ev(`(() => {
      const row = [...document.querySelectorAll('.tree-item:not(.tree-item--outline)')]
        .find((r) => (r.textContent || '').trim() === ${JSON.stringify(name)});
      if (!row) return null;
      const b = row.getBoundingClientRect();
      return { x: b.left + 30, y: b.top + b.height / 2 };
    })()`);
    if (!box) return false;

    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(box.x), y: Math.round(box.y) });
    await sleep(50);
    await rpc('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: Math.round(box.x), y: Math.round(box.y),
      button: 'left', buttons: 1, clickCount: 1,
    });
    await rpc('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: Math.round(box.x), y: Math.round(box.y),
      button: 'left', buttons: 0, clickCount: 1,
    });
    if (double) {
      // 真实的双击：第二次 press/release 带 clickCount 2，浏览器才会派发 dblclick
      await sleep(40);
      await rpc('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: Math.round(box.x), y: Math.round(box.y),
        button: 'left', buttons: 1, clickCount: 2,
      });
      await rpc('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: Math.round(box.x), y: Math.round(box.y),
        button: 'left', buttons: 0, clickCount: 2,
      });
    }
    await sleep(900);
    console.log('  [debug]', JSON.stringify(logs.slice(-4)));
    logs.length = 0;
    return true;
  };

  // ── 准备：打开工作区（文件树要出现三个 md 文件）──
  await clickToolbar('打开文件夹…');
  const treeFiles = await ev(
    `[...document.querySelectorAll('.tree-item:not(.tree-item--outline)')].map((r) => (r.textContent || '').trim())`,
  );
  console.log('文件树：', JSON.stringify(treeFiles));
  if (!treeFiles.includes('alpha.md')) {
    note(`文件树里没有 alpha.md（拿到的是 ${JSON.stringify(treeFiles)}）—— 后面的断言都会恒真`);
  } else {
    // ── 1) 单击 A → 一个预览标签（斜体）──
    await clickTreeFile('alpha.md');
    const afterFirst = await tabs();
    console.log('\n[单击 alpha] 标签：', JSON.stringify(afterFirst));
    if (afterFirst.length !== 1) {
      note(`单击一个文件后有 ${afterFirst.length} 个标签（应为 1）`);
    } else if (!afterFirst[0].italic) {
      note('单击打开的标签不是斜体 —— 用户看不出它是"预览"标签');
    } else {
      pass('单击 alpha → 一个预览标签（斜体）');
    }

    // ── 2) 再单击 B → **替换**，不是新增 ──
    await clickTreeFile('beta.md');
    const afterSecond = await tabs();
    console.log('[单击 beta]  标签：', JSON.stringify(afterSecond));
    if (afterSecond.length !== 1) {
      note(
        `连着单击两个文件后有 ${afterSecond.length} 个标签（应仍是 1）—— ` +
          '预览标签没有被替换，翻几个文件就会塞满标签栏',
      );
    } else if (afterSecond[0].name !== 'beta.md') {
      note(`替换后的标签是 ${JSON.stringify(afterSecond[0].name)}，应为 beta.md`);
    } else if (!afterSecond[0].italic) {
      note('替换出来的标签不是斜体');
    } else {
      pass('单击 beta → 替换掉上一个预览标签（仍只有 1 个）');
    }

    // ── 3) 双击 C → 固定标签（非斜体）──
    await clickTreeFile('gamma.md', { double: true });
    const afterDouble = await tabs();
    console.log('[双击 gamma] 标签：', JSON.stringify(afterDouble));
    const gamma = afterDouble.find((t) => t.name === 'gamma.md');
    if (!gamma) {
      note('双击没能打开 gamma.md —— dblclick 没有接上');
    } else if (gamma.italic) {
      note('双击打开的标签仍是斜体 —— 双击应当把它固定下来');
    } else {
      pass('双击 gamma → 固定标签（非斜体）');
    }

    // ── 4) 此时单击 D → **新建**一个预览标签（因为旧预览已被双击转正）──
    await clickTreeFile('alpha.md');
    const afterMixed = await tabs();
    console.log('[再单击 alpha] 标签：', JSON.stringify(afterMixed));
    const previews = afterMixed.filter((t) => t.previewClass);
    if (afterMixed.length <= afterDouble.length) {
      note(
        `固定标签存在时单击新文件没有新增标签（${afterDouble.length} → ${afterMixed.length}）` +
          ' —— 预览标签不该顶掉固定标签',
      );
    } else if (previews.length !== 1) {
      note(`此时预览标签有 ${previews.length} 个（应恰好 1 个）`);
    } else {
      pass('已有固定标签时，单击新建一个预览标签（固定标签安然无恙）');
    }

    // ── 5) 编辑预览标签 → 自动转正 ──
    const beforeEdit = await tabs();
    const editedName = beforeEdit.find((t) => t.previewClass)?.name;
    await ev(`(() => {
      const el = document.querySelector('.cm-content');
      el.focus();
      document.execCommand('insertText', false, '改一下。');
      return 'ok';
    })()`);
    await sleep(900);
    const afterEdit = await tabs();
    console.log(`[编辑 ${editedName}] 标签：`, JSON.stringify(afterEdit));
    const edited = afterEdit.find((t) => t.name === editedName);
    if (!edited) {
      note(`编辑之后找不到标签 ${JSON.stringify(editedName)}`);
    } else if (edited.italic || edited.previewClass) {
      note(
        `编辑了预览标签，它还是斜体 —— 此时再单击别的文件就会把这份改动顶掉（丢数据）`,
      );
    } else {
      pass('编辑使预览标签转正（不会再被下一次单击顶掉）');
    }

    // ── 6) 每个标签都要有独立的关闭入口 ──
    const closable = (await tabs()).every((t) => t.closeButtons === 1);
    if (!closable) note('有标签缺关闭按钮 —— 那个标签关不掉，只能越积越多');
    else pass('每个标签都有独立的关闭按钮');

    // ── 7) 切标签不能丢未保存的修改 ──
    //
    // 整个应用只有一个 EditorView，切换标签时文档会被整篇换掉。
    // 不把内容存回标签，切走再切回来就会读到磁盘版本 —— 那是数据丢失。
    await ev(`(() => {
      const el = document.querySelector('.cm-content');
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, '未保存的改动XYZ。');
      return 'ok';
    })()`);
    await sleep(800);
    const currentName = (await tabs()).find((t) => t.active)?.name;
    // 切到另一个标签再切回来
    const otherName = (await tabs()).find((t) => !t.active)?.name;
    if (currentName && otherName) {
      await ev(`(() => {
        const t = [...document.querySelectorAll('.tab')].find((x) => (x.textContent || '').includes(${JSON.stringify(otherName)}));
        if (t) t.click();
        return 'ok';
      })()`);
      await sleep(900);
      await ev(`(() => {
        const t = [...document.querySelectorAll('.tab')].find((x) => (x.textContent || '').includes(${JSON.stringify(currentName)}));
        if (t) t.click();
        return 'ok';
      })()`);
      await sleep(900);
      const back = await ev(`document.querySelector('.cm-content').textContent`);
      console.log(`[切走再切回 ${currentName}] 内容：`, JSON.stringify(back));
      if (!(back ?? '').includes('未保存的改动XYZ')) {
        note(
          `切走再切回后未保存的修改不见了（现在的内容是 ${JSON.stringify(back)}）` +
            ' —— 标签没有携带自己的缓冲区',
        );
      } else {
        pass('切标签保留了各自的未保存修改');
      }
    } else {
      note('标签不足两个，切标签的断言被跳过');
    }

    const shot = await rpc('Page.captureScreenshot', { format: 'png' });
    writeFileSync(resolve('screenshots/tabs.png'), Buffer.from(shot.data, 'base64'));
  }


  /*
   * —— 未保存关闭确认：按钮必须真的生效 ——
   *
   * 曾两次栽在"点按钮没反应"：宿主先 dismiss（把 Promise 结算成取消）
   * 再 run，Promise 只能结算一次 → 所有按钮都变成"取消"，
   * 关闭标签不关、退出软件退不掉。这条用例钉死"点按钮 → 标签真的关"。
   */
  if (existsSync(resolve('test/basic.md'))) {
    let tabsBefore = await ev(`document.querySelectorAll('.tab').length`);
    // 前面的用例可能已把所有标签关掉 —— 先建一个（+ 按钮）再脏化
    if (tabsBefore === 0) {
      await ev(`document.querySelector('.tab-add')?.click()`);
      await sleep(500);
      tabsBefore = await ev(`document.querySelectorAll('.tab').length`);
    }
    await ev(`document.querySelector('.cm-content').focus()`);
    await ev(`document.execCommand('insertText', false, 'dirty-marker')`);
    await sleep(400);
    console.log('  [diag]', JSON.stringify({
      tabsBefore,
      dirtyMarks: await ev(`document.querySelectorAll('.tab__dirty').length`),
      closeBtns: await ev(`document.querySelectorAll('.tab__close').length`),
      cmText: (await ev(`document.querySelector('.cm-content')?.textContent ?? ''`)).slice(0, 30),
    }));
    await ev(`([...document.querySelectorAll('.tab__close')].pop())?.click()`);
    await sleep(600);
    const toastText = await ev(`document.querySelector('.toast')?.textContent ?? ''`);
    if (!toastText.includes('未保存')) {
      note(`未保存关闭没有弹确认（toast: ${JSON.stringify(toastText.slice(0, 40))}）`);
    } else {
      await ev(`document.querySelectorAll('.toast__action')[0]?.click()`);
      await sleep(900);
      const tabsAfter = await ev(`document.querySelectorAll('.tab').length`);
      if (tabsAfter >= tabsBefore) {
        note(`点「不保存并关闭」后标签没关（${tabsBefore} → ${tabsAfter}）—— 确认按钮无效`);
      } else {
        console.log(`  ok  未保存关闭确认生效（标签 ${tabsBefore} → ${tabsAfter}）`);
      }
    }
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
    ? `\n标签页检查发现 ${problems.length} 个问题`
    : '\n标签页行为正常（单击预览 / 双击固定 / 编辑转正 / 可关闭 / 各自带缓冲区）',
);
process.exit(problems.length > 0 ? 1 : 0);
