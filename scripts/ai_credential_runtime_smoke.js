const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-ai-credential-')
);

class MemoryStore {
  constructor() {
    this.data = {};
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
  }

  delete(key) {
    delete this.data[key];
  }
}

async function main() {
  try {
    await app.whenReady();
    const output = path.join(tempDir, 'ai-service-manager.cjs');
    const electronStoreMock = path.join(tempDir, 'electron-store.js');
    fs.writeFileSync(electronStoreMock, 'module.exports = class Store {};\n');
    const plugin = {
      name: 'ai-credential-runtime-electron-store-mock',
      setup(build) {
        build.onResolve({ filter: /^electron-store$/ }, () => ({
          path: electronStoreMock,
        }));
      },
    };
    await esbuild.build({
      entryPoints: [path.join(root, 'src/electron/aiServiceManager.js')],
      outfile: output,
      bundle: true,
      external: ['electron'],
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
      plugins: [plugin],
    });
    const { createAiServiceManager } = require(output);
    const store = new MemoryStore();
    const manager = createAiServiceManager({
      configStore: store,
      ipcMain: { handle() {}, on() {} },
      platform: process.platform,
    });
    const saved = manager.saveConfig({
      config: {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com',
        authStrategy: 'bearer',
        jsonMode: 'response-format',
      },
      key: 'podplayer-ai-runtime-smoke-key',
    });
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(store.get('credential').backend, 'windows-dpapi-v1');
    assert.ok(store.get('credential').ciphertext);
    assert.ok(
      !JSON.stringify(store.data).includes('podplayer-ai-runtime-smoke-key')
    );
    assert.strictEqual(manager.getStatus().ok, true);
    assert.strictEqual(manager.getStatus().service.hasKey, true);
    process.stdout.write('ai credential runtime smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    app.quit();
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  app.exit(1);
});
