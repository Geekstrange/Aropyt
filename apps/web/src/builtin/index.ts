/**
 * 内置插件清单。
 *
 * 这一份列表同时是 dogfooding 的验证样本：工具栏、文件树、大纲、
 * 文件操作 —— 全部走 @aropyt/plugin-api，没有一个绕过插件系统直接摸内核。
 *
 * 编辑区的原地渲染（Typora 式）由内核承担，不走插件系统。
 * 剩下这几个留在插件系统里是有意的：它们"可以有不同实现"。
 *
 * 顺序不重要，激活由 activationEvents 决定。
 */

import type { LoadablePlugin } from '@aropyt/core';

import { explorerPlugin } from './explorer.js';
import { filePlugin } from './file.js';
import { formattingPlugin } from './formatting.js';
import { fountainPlugin } from './fountain.js';
import { latexPlugin } from './latex.js';
import { outlinePlugin } from './outline.js';

export const builtinPlugins: readonly LoadablePlugin[] = [
  filePlugin,
  formattingPlugin,
  explorerPlugin,
  outlinePlugin,
  fountainPlugin,
  latexPlugin,
];
