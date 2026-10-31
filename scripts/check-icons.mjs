/**
 * 图标接线的静态校验。
 *
 * 这不是"测一下渲染"，而是把**两类静默失败**钉死。
 * 它们都在真实开发里发生过，且症状全是"界面上看不出哪里不对"：
 *
 *   1. **贴了图标源但没接进生成器** —— 生成器会报错退出（这条还算友好），
 *      但更常见的是"接了生成器、忘了重新生成"：图标源改了，界面纹丝不动。
 *   2. **图标名查不到** —— `Icon` 按名字查，查不到就渲染一个空 span。
 *      按钮变成一个空白方块，不报错、不警告，只有肉眼看才知道。
 *      实际病例：`aropyt.inlineCode` 声明的是手绘的 `code`，
 *      而用户提供的 `行内代码.svg` 生成的 `inlineCode` **从未被任何命令引用**。
 *
 * 判据（两个方向都要查，只查一个方向就漏掉一半）：
 *   图标源 → 生成物 → 命令清单   （缺一环 = 图标白贴）
 *
 * ⚠️ 凡"检查某段代码是否出现"的断言必须先剥注释 ——
 *    本文件头部的 `icon: 'xxx'` 就是这个坑的第五次复现。
 *
 * 用法：npm run check:icons
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

import { buildToolbarIcons } from './make-toolbar-icons.mjs';

const GENERATED = resolve('apps/web/src/components/toolbar-icons.tsx');
const ICON_DIR = resolve('icon');
const SRC_DIR = resolve('apps/web/src');

/**
 * 剥注释。规则与 check:views / check:render 一致：
 * 注释里引用错误写法做说明是正常的，不能被当成违规。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push([name, true]);
  } catch (error) {
    checks.push([name, false, error.message]);
  }
}

// ── 图标源 → 生成物 ──
const { output, entries, missing } = buildToolbarIcons();

check('icon/ 里每个 svg 都在生成器的 NAME_MAP 里登记过', () => {
  assert.equal(
    missing.length,
    0,
    `未登记：${missing.join(', ')}（贴了新图标但没起名字 → 生成器直接罢工）`,
  );
});

check('生成物与 icon/ 同步（改了图标源就要重新生成）', () => {
  const onDisk = readFileSync(GENERATED, 'utf8');
  assert.equal(
    onDisk,
    output,
    'toolbar-icons.tsx 与 icon/ 不一致。图标源改过但没跑 build:icons:toolbar → 界面不会跟着变，且零报错。',
  );
});

/*
 * viewBox 必须**和源文件一致**，不能统一写 1024。
 *
 * 这条不能只靠上面的"生成物 == 生成器的输出"：那比的是生成器跟它自己一致，
 * 生成器里写死 1024 的话两边一起错，闸门照样绿。
 * 所以这里直接拿 icon/*.svg 里的 viewBox 集合做独立比对。
 *
 * 为什么值得单列：h1 的真实网格是 1047 宽、路径画到 x=1047.4，
 * 写死 1024 会把它右边缘裁掉 23.4 单位（宽度 2.29%）——
 * 16px 下约 0.37px，肉眼绝对看不出来，但它就是错的。
 */
check('生成的 viewBox 与图标源逐个一致（宽于 1024 的图标会被裁边）', () => {
  const sourceViewBoxes = readdirSync(ICON_DIR)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => /viewBox="([^"]+)"/.exec(readFileSync(join(ICON_DIR, f), 'utf8'))?.[1])
    .filter(Boolean)
    .sort();
  const generatedViewBoxes = [
    ...readFileSync(GENERATED, 'utf8').matchAll(/^ {4}viewBox: '([^']+)'/gm),
  ]
    .map((m) => m[1])
    .sort();

  assert.deepEqual(
    generatedViewBoxes,
    sourceViewBoxes,
    `生成的 viewBox 与 icon/ 里的对不上：\n        生成：${[...new Set(generatedViewBoxes)].join(' / ')}\n        源：  ${[...new Set(sourceViewBoxes)].join(' / ')}`,
  );
});

// ── 生成物 → 命令清单 ──
const generatedKeys = new Set(
  [...stripComments(readFileSync(GENERATED, 'utf8')).matchAll(/^ {2}([A-Za-z0-9_]+): /gm)].map(
    (m) => m[1],
  ),
);

check('生成物里确实有图标（否则下面两条会恒真）', () => {
  assert.ok(generatedKeys.size >= 10, `只解析到 ${generatedKeys.size} 个图标，解析逻辑可能已失效`);
});

/*
 * 已知"贴了但还没接线"的图标 —— 显式登记，免得闸门长期红着而被无视。
 * 接上线就从这里删掉；新贴图标请直接接线，不要往这里加。
 *
 * 为什么要这份名单而不是放宽判据：白贴的图标不会报错，只会让后来的人
 * 以为自己用的就是它。登记在这一处，至少"还没接线"是写在明面上的。
 */
const PENDING_ICONS = new Set([
  // 文件类型图标：计划按扩展名显示在标签栏 / 文件树，尚未接线
  'fountainFile',
  'mdFile',
  'texFile',
  'language',
]);

/** 递归收集 apps/web/src 下所有标称图标名的位置（只该出现在命令清单里）。 */
function collectDeclaredIcons(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      found.push(...collectDeclaredIcons(full));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    const source = stripComments(readFileSync(full, 'utf8'));
    for (const m of source.matchAll(/icon:\s*'([^']+)'/g)) {
      found.push({ name: m[1], where: name });
    }
  }
  return found;
}

const declared = collectDeclaredIcons(SRC_DIR);

check('确实扫到了命令声明的图标名（扫不到就是这条闸门瞎了）', () => {
  assert.ok(declared.length >= 10, `只扫到 ${declared.length} 处 icon: 'xxx'，收集逻辑可能已失效`);
});

check('命令声明的每个图标名都能解析到图形', () => {
  const unresolved = declared.filter(({ name }) => !generatedKeys.has(name));
  assert.equal(
    unresolved.length,
    0,
    `查不到图形，按钮会渲染成空白块且不报错：${unresolved
      .map((u) => `${u.name}（${u.where}）`)
      .join(', ')}`,
  );
});

check('生成出来的图标都被至少一个命令用到（贴了却不接线 = 白贴）', () => {
  const used = new Set(declared.map((d) => d.name));
  /*
   * 命令清单之外还有**宿主按钮**：App.tsx 里 <Icon name={...} /> 的直接用法
   *（侧栏开关这类"视图开关不进命令注册表"的按钮，见 App.tsx 的约定）。
   * 它们往往带三元（active/普通两态），所以扫的是 Icon 用法里的全部
   * 字符串字面量，而不是去解析表达式。
   */
  const appSource = stripComments(readFileSync(join('apps/web/src', 'App.tsx'), 'utf8'));
  for (const m of appSource.matchAll(/<Icon name=\{([^}]*)\}\s*\/>/g)) {
    for (const lit of m[1].matchAll(/'([A-Za-z0-9_]+)'/g)) {
      used.add(lit[1]);
    }
  }
  // 字符串字面量形态：<Icon name="xxx" />
  for (const m of appSource.matchAll(/<Icon name="([A-Za-z0-9_]+)"/g)) {
    used.add(m[1]);
  }
  const unused = [...generatedKeys].filter(
    (key) => !used.has(key) && !PENDING_ICONS.has(key),
  );
  assert.equal(
    unused.length,
    0,
    `icon/ 里有图标没接到任何命令上：${unused.join(', ')}（要么接上，要么删掉源文件）`,
  );
});

check('兜底图标仍在生成物里（App.tsx 用 detail?.icon ?? defaultPlugin）', () => {
  /*
   * 手绘图标那套已整体删除，兜底也换成了生成物里的 defaultPlugin。
   * 它一旦缺失，插件面板里所有没声明 icon 的命令都会变成空白块。
   */
  assert.ok(generatedKeys.has('defaultPlugin'), '生成物里缺 defaultPlugin 兜底图标');
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
  console.error(`\n图标接线断裂（${failed} 项）。界面会出现空白按钮或与图标源不一致。`);
  process.exit(1);
}

console.log(
  `\n图标接线闭合（${generatedKeys.size} 个图标，其中 ${PENDING_ICONS.size} 个待接线）。`,
);
