/**
 * 视图链路的静态校验。
 *
 * 这不是单元测试，而是一道**防回归闸门**。
 *
 * 背景：M0 曾经出现过一个死锁 —— 视口列表只统计"已注册"的视图，
 * 而 registerView 发生在插件 activate() 里，插件激活又靠 onView 事件，
 * 而 onView 的语义是"这个槽位要用了"。没有视图就不派发事件，
 * 于是预览 / 大纲 / 文件树三个插件永远停在 declared 态。
 * 症状极难定位：没有任何报错，只是界面全空。
 *
 * ⚠️ 这里曾经有"内核固有视图"（预览）与"插件贡献视图"（大纲/文件树）
 *    两条通道并存，各有一套断言。后来分栏预览被整体移除，**只剩插件
 *    通道** —— 但 coreViews 这套机制仍在（将来内核视图还要用它），
 *    所以"布局必须能读到 coreViews"这一条保留。
 *
 * 用法：npm run check:views
 */

import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');

const host = read('packages/core/src/kernel/plugin-host.ts');
const viewHost = read('apps/web/src/components/ViewHost.tsx');
const services = read('apps/web/src/services.ts');
const runtime = read('apps/web/src/runtime.ts');
const builtinIndex = read('apps/web/src/builtin/index.ts');
const pluginHostSrc = read('packages/core/src/kernel/plugin-host.ts');

/**
 * 剥掉注释后再做代码匹配。
 *
 * 这个坑已经踩到第三次了：注释里为了说明"不要这么写"而引用那段错误代码，
 * 结果被动匹配成"违规"。前两次分别在 check:views 的正则窗口和
 * check:render 的 CSS 变量断言上。
 *
 * 凡是"检查某段代码是否出现/不存在"的断言，都必须先剥注释 ——
 * 假阳性会训练人忽略红色，比没有闸门更糟。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pluginHostCode = stripComments(pluginHostSrc);


const checks = [
  // ── 通道一：内核固有视图（预览）──
  ['内核视图不参与 onView 激活', /if \(view\.builtin\) continue/.test(viewHost)],

  // ── 通道二：插件声明的视图 ──
  ['宿主提供 activateFor 触发式激活', /activateFor\(event:\s*string\)/.test(host)],
  [
    '槽位来自清单贡献点，而非运行时注册（打破死锁的前提）',
    /host\.contributions\.views/.test(viewHost),
  ],
  ['槽位反向派发 onView 事件以激活插件', /activateFor\(`onView:/.test(viewHost)],
  ['已请求过的视图不会重复激活', /requestedRef\.current\.has\(view\.id\)/.test(viewHost)],
  [
    // registerView 必须触发 #bump()，否则插件激活后视图仍不出现 ——
    // 而且不会有任何报错。这条断言的窗口要放宽：方法签名本身就有近百字符。
    'registerView 会通知 UI 重渲染（否则激活后视图仍不出现）',
    /registerView\([\s\S]{0,400}?this\.#bump\(\)/.test(services),
  ],

  // ── 布局卫生 ──
  ['插件渲染前先清空容器，避免占位文字与内容叠加', /container\.replaceChildren\(\);/.test(viewHost)],

  // ── 预览主题必须真的跟随主题 ──
  // 这一条来自一个已修的真实 bug：iframe 不继承父文档的 CSS 变量，
  // 原实现写 var(--md-surface-0) 会全部静默回退，预览永远是写死的深色。
  //
  // 注意必须只扫描**代码**：文件头的注释里就写着 `var(--md-surface-0)` 作为
  // 反例说明，整文件匹配会把这个说明当成违规 —— 这是个很讽刺的假阳性。

  // ── 门面不得用展开运算符转发服务实例 ──
  //
  // 踩过一次：`{ ...window, registerView: ... }` 看起来是"转发全部再加一个覆盖"，
  // 实际上展开只复制**自有可枚举属性**，而服务是 class —— 方法都在原型上。
  // 结果是插件拿到的 window 门面里除 registerView 外全是 undefined，
  // 点"打开文件夹"报"命令执行失败"，点"保存"报同样的错，
  // 看起来像命令注册或权限问题，与真正的原因（门面缺方法）毫无关联。
  //
  // 服务实例只会作为这几个名字出现在 plugin-host 里，
  // 对它们用展开就是同一个错误的翻版。
  [
    '服务的门面不靠展开运算符转发（展开会丢掉原型上的方法）',
    !/\{\s*\.\.\.(window|editor|commands|languages|configuration)\b/.test(pluginHostCode),
  ],
];

const failures = checks.filter(([, ok]) => !ok);

for (const [name, ok] of checks) {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}`);
}

if (failures.length > 0) {
  console.error(`\n视图链路断裂（${failures.length} 项）。某类视图将无法显示。`);
  process.exit(1);
}

console.log('\n视图链路闭合（内核固有 + 插件贡献）。');