/**
 * React 侧取文案的 hook。
 *
 * `useSyncExternalStore` 让组件在语言切换时自动重渲染；
 * 返回的 `t` 直接用：`t('toolbar.save')`。
 */
import { useSyncExternalStore } from 'react';
import { getLocale, subscribe, t, type TextKey } from './index';

export function useT(): (key: TextKey, vars?: Record<string, string | number>) => string {
  // 订阅语言变化；返回值只是用来触发重渲染，组件内不读它。
  useSyncExternalStore(subscribe, getLocale, getLocale);
  return t;
}
