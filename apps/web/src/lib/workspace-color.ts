/**
 * 工作区标识色。
 *
 * 标签顶部色条与侧栏工作区条共用这一个函数 —— 两处必须是同一个颜色，
 * 否则用户没法把"这个标签"和"那个工作区"对上，色条就失去意义了。
 *
 * 为什么用 id 哈希而不是固定色表：工作区数量不固定，色表迟早不够用；
 * 哈希能保证同一个工作区在任何时候都是同一个颜色（不需要持久化）。
 * 固定饱和度/亮度，深浅主题下都看得见。
 */
export function workspaceAccent(id: string | null): string {
  if (!id) return 'transparent';
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return `hsl(${String(Math.abs(hash) % 360)} 55% 48%)`;
}
