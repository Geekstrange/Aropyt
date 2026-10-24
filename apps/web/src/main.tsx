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
import { installDebugLog } from './debug/debug-log';

import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 容器');

/*
 * 日志拦截在启动时就安装 —— 否则 F12 打开之前发生的日志（启动、
 * 插件加载、首个文件的打开）全部丢失，面板看起来是空的（实测）。
 * 拦截只是往 500 条环形缓冲里塞，开销可忽略。
 */
installDebugLog();

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
