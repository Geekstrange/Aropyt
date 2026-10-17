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

import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 容器');

createRoot(container).render(<App />);
