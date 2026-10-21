/**
 * 最小复现：把 plugin-host + CommandRegistry + sample 插件打成一个 CJS，
 * 在 node 里跑完整链路（load → activateFor → execute），看真实错误。
 * 一次性诊断脚本，定位完可删。
 */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';

const entry = `
import { PluginHost } from './packages/core/src/kernel/plugin-host.ts';
import { CommandRegistry } from './packages/core/src/kernel/commands.ts';
import { manifest, activate } from './test/sample-plugin.js';

const commands = new CommandRegistry();
const noop = () => {};
const services = {
  commands,
  editor: {
    getText: () => 'hello',
    insertText: (t) => { console.log('[editor.insertText]', t); },
    activeFile: null,
    activeLanguage: 'markdown',
    activeDocument: null,
    onDidChangeActiveFile: () => ({ dispose: noop }),
    onDidChangeActiveDocument: () => ({ dispose: noop }),
    addExtension: () => ({ dispose: noop }),
  },
  ui: { showMessage: (m) => console.log('[ui]', m), showQuickPick: async () => null },
  languages: { register: () => ({ dispose: noop }) },
  storage: {},
  mementoFor: () => ({ get: () => undefined, update: async () => {}, keys: () => [] }),
  onStateChange: () => {},
  configuration: { register: () => ({ dispose: noop }) },
  capabilities: {},
  getWorkspace: () => null,
  safeMode: false,
};

const host = new PluginHost(services, {});
host.load([{ manifest, module: { activate, deactivate: undefined } }]);
console.log('[records]', [...host.records.values()].map((r) => ({ id: r.manifest.id, state: r.state })));
await host.activateFor('onStartupFinished');
console.log('[after activate]', [...host.records.values()].map((r) => ({ id: r.manifest.id, state: r.state, reason: r.reason })));
try {
  await commands.execute('sample.insertDate');
  console.log('EXECUTE OK');
} catch (error) {
  console.error('EXECUTE FAILED:', error.message);
}
`;

writeFileSync('test/.repro-entry.ts', entry);
mkdirSync('test/.out', { recursive: true });
await build({
  entryPoints: ['test/.repro-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'test/.out/repro.cjs',
  external: ['@aropyt/plugin-api'],
});
console.log('bundled');
