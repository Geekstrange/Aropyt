/**
 * 入口。
 *
 * 刻意不使用 <StrictMode>：它会在开发模式下把 effect 执行两次，
 * 而本应用的运行时持有 CodeMirror 实例、Worker 句柄和 IndexedDB 连接 ——
 * 双挂载会造出两套编辑器实例。代价是失去一部分双保险检查，
 * 对这个项目来说是划算的交换。
 *
 * 运行时由 App 内部创建（而不是在这里），原因是编辑器宿主节点必须在
 * 【已经进入文档之后】才交给它 —— CodeMirror 首帧要测量宿主尺寸，
 * 挂在游离节点上会量到 0。
 */

import { createRoot } from 'react-dom/client';
import { installGlobalGuards } from '@aropyt/core';
import { t } from './i18n';
import { trace } from './debug/timeline';
import { installDebugLog, loadPreviousSession } from './debug/debug-log';

import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error(t('app.missingRoot'));

/*
 * 日志拦截在启动时就安装 —— 否则 F12 打开之前发生的日志（启动、
 * 插件加载、首个文件的打开）全部丢失，面板看起来是空的（实测）。
 * 拦截只是往 500 条环形缓冲里塞，开销可忽略。
 *
 * 拦截**永不卸载**：关闭面板之后发生的错误同样要能交出来。
 */
installDebugLog();

/*
 * 兜底守卫：接在日志拦截之后、渲染之前。
 *
 * 它与 installDebugLog 分工不同 —— 后者记"发生了什么"（明细进面板），
 * 前者记"我们没预料到的事发生了"（归到 failure 计数 + 操作轨迹）。
 * 两者都不该缺：没有日志就没有上下文，没有计数就看不出"这个版本比上个
 * 版本更容易崩"。
 *
 * `observeOnly: true` 是刻意的：某些 WebView 一旦对 error 调 preventDefault
 * 就会彻底静默（连 devtools 都看不到），而这里的目标是**记录**，不是兜住。
 */
installGlobalGuards({
  observeOnly: true,
  onFailure: (error, kind) => {
    const detail = error instanceof Error ? error.message : String(error);
    trace('uncaught', `${kind} · ${detail.slice(0, 160)}`, { failed: true });
  },
});

/*
 * 把上一次会话落盘的错误注回日志（异步，不阻塞首屏）。
 *
 * 覆盖的是"崩溃时用户根本打不开面板"这一类 —— 进程被杀 / 断电 /
 * 白屏之后，内存里的日志已经不存在了，只有落盘的那份能说明问题。
 */
void loadPreviousSession();

/*
 * WebView2 的浏览器查找栏在浏览器 UI 层消费 Ctrl+F，比 DOM 更早 ——
 * 不拦就永远轮不到编辑器的 Mod-f。
 *
 * 拦法：capture + preventDefault 挡住浏览器，**再转发一个应用内事件**。
 * 不能只 preventDefault —— CM6 的 keymap 会跳过 defaultPrevented 的事件，
 * 自己的查找也打不开；所以由 App 收到事件后显式调用 editor.openSearch()。
 */
window.addEventListener(
  'keydown',
  (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('aropyt:search'));
    }
  },
  true,
);

createRoot(container).render(<App />);
