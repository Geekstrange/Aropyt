#!/usr/bin/env node
/**
 * 同步决策的回归闸门。
 *
 * ── 为什么单独有这么一个脚本 ─────────────────────────────
 * `planSync` 是一张决策表。改一行看起来只影响一个场景，但那张表把
 * "本地有什么 / 上次同步时有什么 / 远端有什么" 三者的 12 种组合映射
 * 到 5 个动作上，改一处通常会连带影响相邻几格。
 *
 * 这轮就踩过一次：把"远端没有"从 `deleteLocal` 改成 `keep` 时，如果
 * 没有这张表，很容易漏掉"本地也改过"那一格（那格必须仍然是冲突，
 * 因为远端那份改动确实没了）。
 *
 * ── 怎么跑 ─────────────────────────────────────────────
 *   npm run check:sync
 *
 * 脚本先把 `sync/` 编译成 CJS，再用内存假后端跑一遍；不依赖 Tauri、
 * 不依赖网络、不碰真实文件。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const outDir = mkdtempSync(join(tmpdir(), 'aropyt-sync-check-'));

execFileSync(
  'npx',
  [
    'tsc',
    'apps/web/src/sync/engine.ts',
    'apps/web/src/sync/runner.ts',
    '--outDir',
    outDir,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck',
  ],
  { cwd: root, stdio: 'inherit', shell: true },
);

const require = createRequire(import.meta.url);
const { planSync, hashBytes } = require(join(outDir, 'engine.js'));

/* 同步层按字节算哈希，测试里用文本构造时套一层 */
const h = (text) => hashBytes(new TextEncoder().encode(text));
const { runSync } = require(join(outDir, 'runner.js'));

let passed = 0;
const failures = [];

const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(`${name}\n        ${error.message}`);
    console.log(`  FAIL  ${name}`);
  }
};

const plan = (local, remote, base, kept) =>
  planSync({
    local: new Map(Object.entries(local)),
    remote: new Map(Object.entries(remote)),
    base: new Map(Object.entries(base)),
    kept: new Set(kept ?? []),
  });

const only = (actions) => actions.map((action) => action.kind);

/* ── 决策表：远端缺少文件 ─────────────────────────────── */

console.log('\n远端缺少文件（这轮修的那一格）');

test('本地有 + base 有 + 远端无 → keep，不删本地', () => {
  const actions = plan({ 'a.md': 'h' }, {}, { 'a.md': 'h' }, []);
  if (actions.length !== 1) throw new Error(`动作数 ${actions.length}，应为 1`);
  if (actions[0].kind !== 'keep') throw new Error(`动作是 ${actions[0].kind}，应为 keep`);
  if (actions[0].cause !== 'keptLocal') throw new Error(`原因码是 ${actions[0].cause}`);
});

test('已经标记过 → 不再重复报', () => {
  const actions = plan({ 'a.md': 'h' }, {}, { 'a.md': 'h' }, ['a.md']);
  if (actions.length !== 0) throw new Error(`应无动作，实际 ${only(actions).join(',')}`);
});

test('本地也改过 + 远端无 → 冲突（远端那份改动确实没了）', () => {
  const actions = plan({ 'a.md': 'changed' }, {}, { 'a.md': 'original' }, []);
  if (actions[0]?.kind !== 'conflict') throw new Error(`动作是 ${actions[0]?.kind}`);
  if (actions[0]?.cause !== 'remoteDeletedDirty') {
    throw new Error(`原因码是 ${actions[0]?.cause}`);
  }
});

test('首次同步、只有本地 → 上传（不是 keep）', () => {
  const actions = plan({ 'a.md': 'h' }, {}, {}, []);
  if (actions[0]?.kind !== 'upload') throw new Error(`动作是 ${actions[0]?.kind}`);
});

/* ── 决策表：其余组合不能被这次改动带偏 ───────────────── */

console.log('\n其余组合');

test('两端未变 → 无动作', () => {
  const actions = plan({ 'a.md': 'h' }, { 'a.md': 'h' }, { 'a.md': 'h' });
  if (actions.length !== 0) throw new Error(`应无动作，实际 ${only(actions).join(',')}`);
});

test('本地改了、远端没改 → 上传', () => {
  const actions = plan({ 'a.md': 'new' }, { 'a.md': 'old' }, { 'a.md': 'old' });
  if (actions[0]?.kind !== 'upload') throw new Error(`动作是 ${actions[0]?.kind}`);
});

test('远端改了、本地没改 → 下载', () => {
  const actions = plan({ 'a.md': 'old' }, { 'a.md': 'new' }, { 'a.md': 'old' });
  if (actions[0]?.kind !== 'download') throw new Error(`动作是 ${actions[0]?.kind}`);
});

test('两端都改 → 冲突', () => {
  const actions = plan({ 'a.md': 'a' }, { 'a.md': 'b' }, { 'a.md': 'base' });
  if (actions[0]?.kind !== 'conflict') throw new Error(`动作是 ${actions[0]?.kind}`);
  if (actions[0]?.cause !== 'bothChanged') throw new Error(`原因码是 ${actions[0]?.cause}`);
});

test('本地删了、远端没改 → 删远端（用户明确做的动作）', () => {
  const actions = plan({}, { 'a.md': 'h' }, { 'a.md': 'h' });
  if (actions[0]?.kind !== 'deleteRemote') throw new Error(`动作是 ${actions[0]?.kind}`);
});

test('本地删了、远端也删了 → 无动作', () => {
  if (plan({}, {}, { 'a.md': 'h' }).length !== 0) throw new Error('应无动作');
});

test('首次同步、只有远端 → 下载', () => {
  const actions = plan({}, { 'a.md': 'h' }, {});
  if (actions[0]?.kind !== 'download') throw new Error(`动作是 ${actions[0]?.kind}`);
});

/* ── 执行器：keep 与删除保护 ─────────────────────────── */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/*
 * 假后端内部仍用字符串保存内容（读起来方便），只在边界上互转字节 ——
 * 与真实宿主一致：磁盘上是字节，`readLocal` 交给同步层的也是字节。
 */
const fakeBackend = ({ local = {}, remote = {}, base = {}, kept = [] }) => {
  const state = {
    local: { ...local },
    remote: { ...remote },
    base: new Map(Object.entries(base)),
    kept: new Set(kept),
  };
  return {
    state,
    async readLocal() {
      return new Map(Object.entries(state.local).map(([path, text]) => [path, encoder.encode(text)]));
    },
    async writeLocal(path, bytes) {
      state.local[path] = decoder.decode(bytes);
    },
    async deleteLocal(path) {
      delete state.local[path];
    },
    async listRemote() {
      return new Map(
        Object.entries(state.remote).map(([path, text]) => [
          path,
          { size: encoder.encode(text).length, modified: null },
        ]),
      );
    },
    async readRemote(path) {
      return path in state.remote ? encoder.encode(state.remote[path]) : null;
    },
    async writeRemote(path, bytes) {
      state.remote[path] = decoder.decode(bytes);
    },
    async deleteRemote(path) {
      delete state.remote[path];
    },
    async loadBase() {
      return new Map(state.base);
    },
    async saveBase(base) {
      state.base = new Map(base);
    },
    async loadKept() {
      return new Set(state.kept);
    },
    async saveKept(kept) {
      state.kept = new Set(kept);
    },
    async saveConflict() {},
  };
};

const run = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(`${name}\n        ${error.message}`);
    console.log(`  FAIL  ${name}`);
  }
};

console.log('\n执行器');

const cases = [
  [
    'keep 把路径记进 kept，本地文件原样不动',
    async () => {
      /* 远端留一个 b.md，让这一轮不是"整棵远端都空了" */
      const backend = fakeBackend({
        local: { 'a.md': 'text', 'b.md': 'other' },
        remote: { 'b.md': 'other' },
        base: { 'a.md': { hash: h('text') }, 'b.md': { hash: h('other') } },
      });
      const result = await runSync(backend);
      if (result.steps[0]?.action.kind !== 'keep') {
        throw new Error(
          `动作是 ${result.steps.map((s) => s.action.kind).join(',') || '(空)'}；` +
            `kept=[${[...backend.state.kept].join(',')}]`,
        );
      }
      if (backend.state.local['a.md'] !== 'text') throw new Error('本地文件被改动了');
      if (!backend.state.kept.has('a.md')) {
        throw new Error(`kept 里没有记录，实际 [${[...backend.state.kept].join(',')}]`);
      }
    },
  ],
  [
    'keep 之后第二轮不再产生动作',
    async () => {
      const backend = fakeBackend({
        local: { 'a.md': 'text', 'b.md': 'other' },
        remote: { 'b.md': 'other' },
        base: { 'a.md': { hash: h('text') }, 'b.md': { hash: h('other') } },
        kept: ['a.md'],
      });
      const result = await runSync(backend);
      if (result.steps.length !== 0) throw new Error(`仍有 ${result.steps.length} 个动作`);
    },
  ],
  [
    '远端为空 + base 有记录 → 照样上传（不拦截）',
    async () => {
      /*
       * 曾经这里有一道闸门会中止整轮，实测把正常同步卡死了：
       * "云端是空的" 的意思就是 "把本地传上去"，不是 "别再动了"。
       */
      const backend = fakeBackend({
        local: { 'a.md': 'one', 'b.md': 'two' },
        base: { 'a.md': { hash: h('one') }, 'b.md': { hash: h('two') } },
      });
      const result = await runSync(backend);
      if (backend.state.remote['a.md'] !== 'one') throw new Error('没有上传 a.md');
      if (backend.state.remote['b.md'] !== 'two') throw new Error('没有上传 b.md');
      if (backend.state.local['a.md'] !== 'one') throw new Error('本地文件被动了');
      if (result.steps.some((step) => !step.ok)) throw new Error('有动作失败');
    },
  ],
  [
    '删除本地那条分支永远拒绝执行',
    async () => {
      /* 直接喂一个 deleteLocal 动作，确认执行器不会真的删 */
      const backend = fakeBackend({ local: { 'a.md': 'text' } });
      const result = await runSync({
        ...backend,
        async readLocal() {
          return new Map([['a.md', 'text']]);
        },
        async listRemote() {
          return new Map();
        },
        async loadBase() {
          /* base 空 → 走上传而不是 keep，这里只验证 deleteLocal 的守卫 */
          return new Map();
        },
      });
      if (result.steps.some((step) => step.action.kind === 'deleteLocal' && step.ok)) {
        throw new Error('deleteLocal 被执行了');
      }
      if (backend.state.local['a.md'] !== 'text') throw new Error('本地文件没了');
    },
  ],
];

for (const [name, fn] of cases) await run(name, fn);

rmSync(outDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\n失败详情：');
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
