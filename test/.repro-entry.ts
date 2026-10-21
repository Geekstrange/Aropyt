
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
