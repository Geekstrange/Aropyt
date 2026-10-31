/**
 * 字数统计。
 *
 * 单独一个文件而不是放在 `markdown.ts` 里：那个模块带 markdown-it +
 * highlight.js，**刻意不从根入口导出**（否则整个渲染引擎进首屏预算）。
 * 而状态栏每次重渲染都要算字数，只需要这一个纯函数 —— 混在一起会让
 * "显示几个数字"这件事被迫拖进几十 KB 的解析器。
 */

export interface DocStats {
  words: number;
  chars: number;
  lines: number;
  readMinutes: number;
}

/**
 * 统计一段 markdown 文本。
 *
 * 口径：
 *  - `chars`：**去掉所有空白**后的字符数（中英文都算一个）；
 *  - `words`：西文按词切分，中日文按字计词（一个汉字 ≈ 一个词）；
 *  - `lines`：按 `\n` 计，空文档算 0 行；
 *  - `readMinutes`：按 300 词/分钟估算，最少 1 分钟。
 *
 * 这套口径与 Typora 一致 —— 中文用户理解的"字数"就是这里面的 `chars`。
 */
export function countStats(source: string): DocStats {
  const chars = source.replace(/\s/g, '').length;
  const cjk = (source.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) ?? []).length;
  const words = (source.match(/[A-Za-z0-9_'-]+/g) ?? []).length + cjk;
  return {
    words,
    chars,
    lines: source ? source.split('\n').length : 0,
    readMinutes: Math.max(1, Math.round(words / 300)),
  };
}
