/**
 * Typora 式内联渲染的行为校验。
 *
 * 这些不是"测一下函数"，而是把**产品定义**钉成断言：
 * Typora 的核心交互是"光标不在时藏标记、在时显标记"。
 * 这条规则一旦破了，编辑器就不好用了 —— 但它不会报错，只会觉得"怪"。
 *
 * 做法：直接构造 CM6 state（不需要真实 DOM），
 * 跑装饰构建，断言哪些区间被替换、哪些被标记。
 *
 * 用法：node scripts/check-inline-render.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import assert from 'node:assert/strict';

// ── 直接复刻装饰构建的核心规则（与 inline-render.ts 保持一致）──
// 单独抽出来测是为了能在无 DOM 环境跑；真实渲染由 CM6 负责。
const MARKER_TYPES = new Set(['HeaderMark', 'ListMark', 'QuoteMark', 'HorizontalRule']);
const PAIRED_MARKERS = new Set(['EmphasisMark', 'CodeMark']);

function buildRanges(state, activeLines) {
  const doc = state.doc;
  const tree = syntaxTree(state);
  const replaced = [];
  const marked = [];
  const lineDecorations = [];
  const pairMarks = [];

  const cursor = tree.cursor();
  do {
    const name = cursor.type.name;
    if (PAIRED_MARKERS.has(name)) {
      pairMarks.push({ from: cursor.from, to: cursor.to, line: doc.lineAt(cursor.from).number });
      continue;
    }
    if (MARKER_TYPES.has(name)) {
      const line = doc.lineAt(cursor.from).number;
      if (!activeLines.has(line)) replaced.push({ from: cursor.from, to: cursor.to, text: doc.sliceString(cursor.from, cursor.to) });
      continue;
    }
    if (name.startsWith('ATXHeading') || name.startsWith('SetextHeading')) {
      lineDecorations.push({ line: doc.lineAt(cursor.from).number, name });
      continue;
    }
    const line = doc.lineAt(cursor.from).number;
    if (!activeLines.has(line)) marked.push({ from: cursor.from, to: cursor.to, name });
  } while (cursor.next());

  // 成对标记
  const byLength = new Map();
  for (const m of pairMarks) {
    const len = m.to - m.from;
    byLength.set(len, [...(byLength.get(len) ?? []), m]);
  }
  for (const list of byLength.values()) {
    for (let i = 0; i + 1 < list.length; i += 2) {
      const a = list[i];
      const b = list[i + 1];
      if (a.line !== b.line) continue;
      if (activeLines.has(a.line)) continue;
      replaced.push({ from: a.from, to: a.to, text: doc.sliceString(a.from, a.to) });
      replaced.push({ from: b.from, to: b.to, text: doc.sliceString(b.from, b.to) });
    }
  }

  return { replaced, marked, lineDecorations };
}

function makeState(text, cursorLine) {
  return EditorState.create({
    doc: text,
    extensions: [markdown({ base: markdownLanguage })],
    selection: { anchor: 0 },
  }).update({ selection: { anchor: 0 } }).state;
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push([name, true]);
  } catch (error) {
    checks.push([name, false, error.message.split('\n')[0]]);
  }
}

// ── 断言组 ──

check('光标在别处时，# 标记被隐藏', () => {
  const src = '# 标题\n\n正文';
  const s = makeState(src);
  const { replaced } = buildRanges(s, new Set([3])); // 光标在第 3 行
  assert.ok(
    replaced.some((r) => r.text === '#'),
    '应隐藏标题的 # 标记',
  );
});

check('光标在标题行时，# 标记显形', () => {
  const src = '# 标题\n\n正文';
  const s = makeState(src);
  const { replaced } = buildRanges(s, new Set([1]));
  assert.ok(
    !replaced.some((r) => r.text === '#'),
    '光标所在行的 # 不该被隐藏',
  );
});

check('成对强调标记两侧同时隐藏', () => {
  const src = '**粗体**';
  const s = makeState(src);
  const { replaced } = buildRanges(s, new Set([9])); // 光标在文档外
  const marks = replaced.filter((r) => r.text === '**');
  assert.equal(marks.length, 2, `应隐藏两侧 **，实际 ${marks.length} 个`);
});

check('单个未闭合的 * 不隐藏（用户正在输入）', () => {
  const src = '**粗体';
  const s = makeState(src);
  const { replaced } = buildRanges(s, new Set([9]));
  const stars = replaced.filter((r) => r.text.includes('*'));
  assert.equal(stars.length, 0, '未闭合的标记不该隐藏，否则用户看不见自己在输入什么');
});

check('跨行的强调不隐藏', () => {
  const src = '**开始\n结束**';
  const s = makeState(src);
  const { replaced } = buildRanges(s, new Set([9]));
  assert.equal(
    replaced.filter((r) => r.text.includes('*')).length,
    0,
    '跨行说明还没写完，不该隐藏',
  );
});

check('列表标记被隐藏', () => {
  const src = '- 项目一\n- 项目二';
  const s = makeState(src);
  const { replaced } = buildRanges(s, new Set([9]));
  assert.ok(replaced.some((r) => r.text === '-'), '应隐藏列表符号');
});

check('引用标记被隐藏', () => {
  const src = '> 引用';
  const s = makeState(src);
  const { replaced } = buildRanges(s, new Set([9]));
  assert.ok(replaced.some((r) => r.text === '>'), '应隐藏引用符号');
});

check('标题使用行装饰（样式需作用到整行）', () => {
  const src = '# 一级\n## 二级';
  const s = makeState(src);
  const { lineDecorations } = buildRanges(s, new Set([9]));
  assert.equal(lineDecorations.length, 2, '两个标题都该有行装饰');
  assert.ok(lineDecorations.some((d) => d.name === 'ATXHeading1'));
  assert.ok(lineDecorations.some((d) => d.name === 'ATXHeading2'));
});

check('光标行不加行内样式（避免光标附近闪烁）', () => {
  const src = '普通文本\n\n**粗体**';
  const s = makeState(src);
  const { marked } = buildRanges(s, new Set([3]));
  const strongOnLine3 = marked.filter(
    (m) => m.name === 'StrongEmphasis' && s.doc.lineAt(m.from).number === 3,
  );
  assert.equal(strongOnLine3.length, 0, '光标行的加粗不加装饰');
});

check('非光标行加行内样式', () => {
  const src = '**粗体**\n\n普通';
  const s = makeState(src);
  const { marked } = buildRanges(s, new Set([3]));
  assert.ok(marked.some((m) => m.name === 'StrongEmphasis'), '非光标行应加粗');
});

// ── 主题变量完整性 ──
//
// 内核对 --font-mono / --font-sans 等变量是**只引用不定义**的（宿主定义）。
// 漏定义时 `font-family: var(--font-mono)` 整条声明在计算值阶段失效，
// 字体静默回退到继承值 —— 没有报错、没有警告，只是"看起来不太对"。
// 这个项目踩过一次（编辑器从来就不是等宽的，直到做模式切换才发现）。
check('内核引用的主题变量都在宿主里定义过', () => {
  const coreRefs = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts')) {
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) coreRefs.add(m[1]);
      }
    }
  };
  walk('packages/core/src');

  const hostCss = readFileSync('apps/web/src/styles.css', 'utf8');
  const hostDefs = new Set([...hostCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  const missing = [...coreRefs].filter((v) => !hostDefs.has(v)).sort();
  assert.equal(
    missing.length,
    0,
    `内核引用但宿主未定义：${missing.join(', ')}（会导致该声明静默失效）`,
  );
});

// ── 两套色板必须定义完全相同的变量集合 ──
//
// 这条是本项目最容易静默出错的地方之一：浅色色板漏写一个变量不会报错、
// 不会有警告，只会让那一处回退到深色的值 —— 表现为"浅色模式下某个角落
// 还是暗的"，而且只有正好看到那个角落才发现。
check('深浅两套色板定义了相同的变量集合', () => {
  const css = readFileSync('apps/web/src/styles.css', 'utf8');

  /** 从 `@palette:<name>` 标记后第一个 { 开始，取到配对的 }。 */
  const palette = (name) => {
    const marker = css.indexOf(`@palette:${name}`);
    assert.ok(marker >= 0, `styles.css 里找不到 @palette:${name} 标记`);
    const open = css.indexOf('{', marker);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          const block = css.slice(open, i);
          return new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
        }
      }
    }
    throw new Error(`@palette:${name} 的代码块没有正确闭合`);
  };

  const dark = palette('dark');
  const light = palette('light');

  const onlyDark = [...dark].filter((v) => !light.has(v)).sort();
  const onlyLight = [...light].filter((v) => !dark.has(v)).sort();

  // 两个方向都要断言。
  // 第一版这里写成了 assert.equal(onlyDark.length, 某个变形) —— 那个表达式
  // 在 onlyDark 非空时恰好等于 onlyDark.length，于是断言恒真、永远不报错。
  // 一个不会失败的闸门比没有闸门更糟：它给人虚假的安全感。
  assert.equal(onlyDark.length, 0, `只有深色定义了：${onlyDark.join(', ')}`);
  assert.equal(onlyLight.length, 0, `只有浅色定义了：${onlyLight.join(', ')}`);
  // 变量数太少说明解析逻辑本身坏了（比如标记被改名），不是"通过"。
  assert.ok(dark.size > 10, `深色色板只解析出 ${dark.size} 个变量，解析逻辑可疑`);
});

// ── 首帧脚本与主题服务的键必须一致 ──
//
// index.html 里那段内联脚本是 theme.ts 的唯一重复点（为了首帧不闪，
// 必须同步执行）。两边的存储键一旦不一致，表现是"主题选了但下次启动又变回去"，
// 很难联想到是键写错了。
check('index.html 的内联主题脚本与 theme.ts 使用同一个存储键', () => {
  const html = readFileSync('apps/web/index.html', 'utf8');
  const ts = readFileSync('apps/web/src/theme.ts', 'utf8');

  const tsKey = /THEME_STORAGE_KEY\s*=\s*'([^']+)'/.exec(ts)?.[1];
  assert.ok(tsKey, 'theme.ts 里找不到 THEME_STORAGE_KEY');

  assert.ok(
    html.includes(`'${tsKey}'`),
    `index.html 的内联脚本没有使用 ${tsKey} —— 首帧读不到偏好会闪一下`,
  );
  assert.ok(
    html.includes('data-theme'),
    'index.html 的内联脚本必须设置 data-theme',
  );
});

// ── 渲染态样式只能有一处 owner ──
//
// theme.ts 里曾经有三条 `&.aropyt-render-mode ...` 规则（无衬线字体、
// 收窄的正文宽度、行 padding），与渲染层自己主题里的同名规则**重复**。
// 因为带 `.aropyt-render-mode` 前缀后特异性更高（2 个 class vs 1 个），
// 它们**静默压住了渲染层的定义** —— 症状是"在渲染层改样式完全没反应"，
// 会让人以为改错了文件。
//
// 实测代价：`max-width: 46em` 在渲染层删掉后宽度依然 690px，
// 排查了好一阵才想到是另一处压着。
//
// 所以这里钉死：渲染态样式只允许定义在 wysiwyg/inline-render.ts，
// theme.ts 里不得再出现 `aropyt-render-mode` 前缀的规则。
check('渲染态样式只有一处 owner（theme.ts 里不得有模式前缀规则）', () => {
  const ts = readFileSync('packages/core/src/theme.ts', 'utf8');
  // 先剥注释 —— 注释里正举着这条规则当反面例子，不剥会把自己判成违规
  const code = ts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  assert.ok(
    !/aropyt-render-mode\s/.test(code),
    'theme.ts 里又出现了 aropyt-render-mode 前缀的样式规则 —— ' +
      '它会以更高特异性压住渲染层的定义，且不会有任何报错。' +
      '渲染态样式请写在 wysiwyg/inline-render.ts',
  );

  // 反向确认：渲染层确实还在定义渲染态样式（否则上面那条会恒真）
  const render = readFileSync('packages/core/src/wysiwyg/inline-render.ts', 'utf8');
  assert.ok(
    render.includes('--md-font-size'),
    '渲染层里找不到 .cm-scroller 的字体声明 —— 渲染态样式可能被误删了',
  );
  assert.ok(
    render.includes('cm-md-list-line'),
    '渲染层里找不到列表行装饰 —— 列表符号那部分可能被误删了',
  );
});

// ── 色板之外不应再有硬编码颜色 ──
//
// 硬编码颜色会绕过主题系统：深浅切换时它不变，于是浅色下冒出深色元素。
check('色板之外没有硬编码色值', () => {
  const css = readFileSync('apps/web/src/styles.css', 'utf8');
  // 去掉注释再去匹配 —— 注释里引用色值做说明是正常的
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // 逐个 :root / :root[data-theme=...] 块剔除，剩下的才是"别处"。
  // 注意注释在上一步已被剥掉，所以这里按选择器定位而不是按 @palette 标记。
  let stripped = code;
  const blocks = code.match(/:root(\[data-theme='light'\])?\s*\{[^}]*\}/g) ?? [];
  for (const b of blocks) stripped = stripped.replace(b, '');

  const hardcoded = [...stripped.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)]
    .map((m) => m[0])
    // currentColor / transparent 之类不是色值字面量，正则已经排除了
    .filter((v) => !/^(#(fff|000|ffffff|000000))$/i.test(v));

  assert.equal(
    hardcoded.length,
    0,
    `色板外出现硬编码颜色：${hardcoded.slice(0, 6).join(', ')}（切主题时不会跟着变）`,
  );
});

// ── 图标目录不许有生成器范围外的文件 ──
//
// 踩过一次：换 logo 后 `256x256.png` 与 `512x512.png` 一直是旧脚本留下的
// 残留，界面上看着像"生成没生效"。根因是生成器只写它引用的那几个文件名，
// 而目录里还有别的同名尺寸文件。
//
// 判据很简单：**src-tauri/icons 里的每个文件都必须是生成器会写的那几个**。
// 多出来的文件没人负责，迟早会过期。
check('图标目录没有生成器范围外的残留文件', () => {
  const dir = 'src-tauri/icons';
  if (!existsSync(dir)) return; // 还没生成过图标，跳过

  // 与 scripts/make-icons.mjs 的写入列表保持一致
  const generated = new Set([
    '32x32.png',
    '128x128.png',
    '128x128@2x.png',
    '256x256.png',
    '512x512.png',
    'icon.png',
    'icon.ico',
    // macOS 由 `tauri icon` 生成，不在本脚本范围内，但要允许存在
    'icon.icns',
  ]);

  const stray = readdirSync(dir).filter((name) => !generated.has(name));
  assert.equal(
    stray.length,
    0,
    `图标目录里有生成器不产出的文件：${stray.join(', ')}（它们不会随 logo 更新，迟早显示过期图标）`,
  );
});

// ── 输出 ──
let failed = 0;
for (const [name, ok, msg] of checks) {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}`);
  if (!ok) {
    failed += 1;
    if (msg) console.log(`        ${msg}`);
  }
}

if (failed > 0) {
  console.error(`\n内联渲染行为异常（${failed} 项）。`);
  process.exit(1);
}
console.log('\n内联渲染行为符合 Typora 交互定义。');