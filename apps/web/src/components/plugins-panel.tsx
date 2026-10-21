import { useState } from 'react';
import type { PluginRecord } from '@aropyt/core';
import type { AropytRuntime } from '../runtime';
import { Icon } from './Icons.js';

/**
 * 插件管理面板（v0.1.0）。
 *
 * 从"showMessage 文本浮层"升级为列表视图 —— 三件事终于有位置放：
 * 图标、失败原因、每项的操作按钮。
 */
const STATE_LABEL: Record<PluginRecord['state'], string> = {
  declared: '未激活',
  active: '已启用',
  disabled: '已禁用',
  failed: '加载失败',
};

interface PluginsPanelProps {
  runtime: AropytRuntime;
  records: readonly PluginRecord[];
  onClose: () => void;
}

/**
 * 插件图标：manifest.icon 可以是内联 SVG 字符串，也可以是宿主图标名。
 * 未设置时用 defaultPlugin。
 *
 * 内联 SVG 会先剥掉 script 与 on* 事件属性 —— 插件本身已有完整权限，
 * 这一层是防"无意中粘贴了带脚本的 SVG"。
 */
function PluginIcon({ icon }: { icon?: string }) {
  const raw = icon?.trim();
  if (raw && raw.startsWith('<')) {
    const cleaned = raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son\w+\s*=\s*'[^']*'/gi, '');
    return (
      <span className="plugin-item__icon" dangerouslySetInnerHTML={{ __html: cleaned }} />
    );
  }
  return (
    <span className="plugin-item__icon">
      <Icon name={(raw as never) || 'defaultPlugin'} />
    </span>
  );
}

export function PluginsPanel({ runtime, records, onClose }: PluginsPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const externals = records.filter((record) => !runtime.builtinPluginIds.has(record.manifest.id));

  const handleToggle = async (record: PluginRecord): Promise<void> => {
    const enabled = record.state === 'active' || record.state === 'declared';
    setBusy(record.manifest.id);
    try {
      await runtime.setPluginEnabled(record.manifest.id, !enabled);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (record: PluginRecord): Promise<void> => {
    setBusy(record.manifest.id);
    try {
      await runtime.deleteExternalPlugin(record.manifest.id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="settings-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="插件管理"
      onClick={onClose}
    >
      <div className="settings-dialog" onClick={(event) => event.stopPropagation()}>
        <header className="settings-dialog__header">
          <h2>插件</h2>
          <button type="button" className="settings-dialog__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="settings-dialog__body">
          {externals.length === 0 ? (
            <p className="plugins-empty">
              还没有导入任何插件。插件是单个 <code>.js</code> 文件，需导出 manifest 与 activate。
            </p>
          ) : (
            <ul className="plugin-list">
              {externals.map((record) => {
                const id = record.manifest.id;
                const name = record.manifest.name ?? id;
                const enabled = record.state === 'active' || record.state === 'declared';
                return (
                  <li key={id} className="plugin-item">
                    <PluginIcon icon={record.manifest.icon} />
                    <div className="plugin-item__main">
                      <div className="plugin-item__title">
                        <span className="plugin-item__name">{name}</span>
                        <span className={`plugin-item__state plugin-item__state--${record.state}`}>
                          {STATE_LABEL[record.state]}
                        </span>
                      </div>
                      <div className="plugin-item__meta">
                        v{record.manifest.version ?? '0.0.0'} · {id}
                      </div>
                      {record.reason && <div className="plugin-item__reason">{record.reason}</div>}
                    </div>
                    <div className="plugin-item__actions">
                      <button
                        type="button"
                        className="plugin-action"
                        disabled={busy === id}
                        onClick={() => void handleToggle(record)}
                      >
                        {enabled ? '禁用' : '启用'}
                      </button>
                      <button
                        type="button"
                        className="plugin-action plugin-action--danger"
                        disabled={busy === id}
                        onClick={() => void handleDelete(record)}
                      >
                        删除
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="plugins-footer">
          <button type="button" className="settings-button" onClick={() => runtime.importExternalPlugin()}>
            导入插件…
          </button>
          <span className="plugins-panel__hint">启用/禁用与删除在重启后生效</span>
        </footer>
      </div>
    </div>
  );
}
