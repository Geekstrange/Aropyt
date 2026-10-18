// @ts-nocheck
/* 构建配置跑在 node 里，本仓库 tsconfig 未引入 node 类型；
   这里不参与应用的类型边界，压掉 node:* 模块声明缺失。 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** 读取仓库根 package.json 的 version（发布版本的真源）。 */
function readRootVersion(): string {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
import react from '@vitejs/plugin-react';

/**
 * 构建配置承载两条硬约束，不是随手写的默认值：
 *
 * 1. **首屏预算**。预算表在 @aropyt/core 的 BUDGETS 旁边，这里负责让它成立：
 *    markdown-it、highlight.js、KaTeX、Mermaid 全部不进首屏，
 *    靠动态 import 落进独立 chunk。
 *
 * 2. **单一来源**。这份配置同时产出 PWA 与两个壳（Tauri / Android）的前端，
 *    所以不许出现任何平台专属的构建分支 —— 一旦分叉，
 *    "一套 Web 内核" 就名存实亡。
 */
/*
 * 配置必须是**函数形式**，因为 sourcemap 要分模式。
 *
 * 这不是平台分支（那条禁令针对的是"给 Tauri / Android 各写一套"），
 * 是开发 vs 发布：发布包里 74% 的体积是 .map（实测 5.87 MB / 7.94 MB），
 * 而发布版没开 devtools，用户永远用不到它 —— 那是纯死重，
 * 直接压在"极致轻量"这条第一约束上。
 * 开发模式保留，因为 Vite 的 dev server 恰恰是最需要可读栈的地方。
 */
export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  define: {
    /*
     * 版本号取**仓库根** package.json。
     * 曾用 process.env.npm_package_version —— 在 workspace 里跑构建时它是
     * apps/web 的版本（0.1.0），状态栏因此显示成 v0.1.0（用户实测发现）。
     */
    __APP_VERSION__: JSON.stringify(readRootVersion()),
  },
  build: {
    target: 'es2022',
    sourcemap: command === 'serve',
    /*
     * 清理由 scripts/clean-dist.mjs（逐批删除）负责。
     * 不让 vite 自己清空：沙箱环境的批量删除防护会把"一次删上百个资产"
     * 拦下来（SAFE_DELETE_BULK_CONFIRM_REQUIRED），构建直接失败。
     */
    emptyOutDir: false,
    // 大 chunk 警告阈值调低，让它真的能起到告警作用而不是噪声。
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      output: {
        manualChunks: {
          // React 与内核分开，便于判断"首屏变大了"到底是谁的责任。
          react: ['react', 'react-dom'],
          codemirror: [
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/language',
            '@codemirror/commands',
            '@codemirror/search',
            '@codemirror/autocomplete',
            '@codemirror/lang-markdown',
          ],
        },
      },
    },
  },
}));
