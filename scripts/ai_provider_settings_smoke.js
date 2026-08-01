const assert = require('assert');
const EventEmitter = require('events');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-ai-provider-settings-')
);

class MemoryStore {
  constructor(seed) {
    this.data = Object.assign({}, seed || {});
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

function createSafeStorage(available) {
  return {
    isEncryptionAvailable() {
      return available !== false;
    },
    encryptString(value) {
      return Buffer.from('safe:' + String(value), 'utf8');
    },
    decryptString(value) {
      return String(Buffer.from(value).toString('utf8')).replace(/^safe:/, '');
    },
  };
}

function loadResponse(onResponse, statusCode, body) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.setEncoding = () => {};
  process.nextTick(() => {
    onResponse(response);
    response.emit('data', body);
    response.emit('end');
  });
}

function createTransport(plans, captures) {
  const queue = plans || [];
  return {
    request(options, onResponse) {
      const request = new EventEmitter();
      request.write = body => {
        request.body = body;
      };
      request.destroy = () => {
        request.destroyed = true;
      };
      request.end = () => {
        captures.push({ options, body: request.body || '' });
        const plan = queue.shift();
        if (typeof plan === 'function') plan({ options, onResponse, request });
      };
      return request;
    },
  };
}

function successPlan() {
  return ({ onResponse }) => {
    loadResponse(
      onResponse,
      200,
      JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
      })
    );
  };
}

function errorPlan(status, body) {
  return ({ onResponse }) => loadResponse(onResponse, status, body || '{}');
}

async function buildModules() {
  const mockDir = path.join(tempDir, 'mocks');
  fs.mkdirSync(mockDir, { recursive: true });
  const electron = path.join(mockDir, 'electron.js');
  const electronStore = path.join(mockDir, 'electron-store.js');
  fs.writeFileSync(
    electron,
    'export const ipcMain = { handle() {}, on() {} }; export const safeStorage = {};\n'
  );
  fs.writeFileSync(electronStore, 'export default class Store {}\n');
  const managerOutput = path.join(tempDir, 'manager.cjs');
  const configOutput = path.join(tempDir, 'config.cjs');
  const aliases = {
    electron,
    'electron-store': electronStore,
  };
  const plugin = {
    name: 'ai-provider-settings-mocks',
    setup(build) {
      Object.keys(aliases).forEach(filter => {
        build.onResolve({ filter: new RegExp('^' + filter + '$') }, () => ({
          path: aliases[filter],
        }));
      });
    },
  };
  await Promise.all([
    esbuild.build({
      entryPoints: [path.join(root, 'src/electron/aiServiceManager.js')],
      outfile: managerOutput,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
      plugins: [plugin],
    }),
    esbuild.build({
      entryPoints: [path.join(root, 'src/utils/podcast/aiServiceConfig.js')],
      outfile: configOutput,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    }),
  ]);
  return { manager: require(managerOutput), config: require(configOutput) };
}

function providerConfig(provider, overrides) {
  return Object.assign(
    {
      provider,
      model: 'smoke-model',
      baseUrl: 'https://service.example.test/v1',
      authStrategy: 'bearer',
      jsonMode: 'response-format',
    },
    overrides || {}
  );
}

async function main() {
  try {
    const { manager: managerModule, config } = await buildModules();
    const providers = config.getAiProviderOptions();
    assert.deepStrictEqual(
      providers.map(item => item.id),
      ['deepseek', 'openai', 'gemini', 'openrouter', 'local', 'custom']
    );
    assert.deepStrictEqual(
      providers.map(item => [item.id, item.baseUrl, item.authStrategy]),
      [
        ['deepseek', 'https://api.deepseek.com', 'bearer'],
        ['openai', 'https://api.openai.com/v1', 'bearer'],
        ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'bearer'],
        ['openrouter', 'https://openrouter.ai/api/v1', 'bearer'],
        ['local', 'http://127.0.0.1:11434/v1', 'none'],
        ['custom', '', 'bearer'],
      ]
    );
    providers.forEach(provider => {
      const current = config.createAiProviderPresetConfig(provider.id);
      if (provider.id !== 'custom') {
        assert.ok(current.model || provider.id === 'custom');
        assert.ok(current.baseUrl || provider.id === 'custom');
      }
    });
    assert.strictEqual(
      config.resolveOpenAiChatUrl('https://service.example.test/v1').pathname,
      '/v1/chat/completions'
    );
    assert.throws(
      () => config.resolveOpenAiChatUrl('http://service.example.test/v1'),
      error => error && error.code === 'insecure-endpoint'
    );
    assert.strictEqual(
      config.resolveOpenAiChatUrl('http://127.0.0.1:11434/v1').protocol,
      'http:'
    );
    assert.strictEqual(
      config.resolveOpenAiChatUrl('http://[::1]:1234/v1').protocol,
      'http:'
    );

    const httpsCaptures = [];
    const httpCaptures = [];
    const httpsPlans = [successPlan(), successPlan()];
    const httpPlans = [successPlan()];
    const configStore = new MemoryStore();
    const service = managerModule.createAiServiceManager({
      configStore,
      safeStorage: createSafeStorage(true),
      transports: {
        https: createTransport(httpsPlans, httpsCaptures),
        http: createTransport(httpPlans, httpCaptures),
      },
      now: () => 1700000000000,
    });

    assert.strictEqual(httpsCaptures.length, 0, 'status must never auto-connect');
    const legacy = service.migrateLegacy({
      legacy: true,
      legacyKey: 'legacy-secret-for-smoke',
      config: providerConfig('deepseek', {
        baseUrl: 'https://service.example.test/v1',
      }),
    });
    assert.strictEqual(legacy.ok, true);
    assert.strictEqual(legacy.migrated, true);
    assert.strictEqual(legacy.service.status, 'pending');
    assert.strictEqual(legacy.service.hasKey, true);
    assert.ok(!JSON.stringify(legacy.service).includes('legacy-secret-for-smoke'));
    assert.ok(!Object.prototype.hasOwnProperty.call(legacy.service, 'key'));
    assert.strictEqual(httpsCaptures.length, 0, 'migration must not auto-connect');

    const verified = await service.testConnection({
      config: providerConfig('deepseek', {
        baseUrl: 'https://service.example.test/v1',
      }),
      requestId: 'verify-deepseek',
    });
    assert.strictEqual(verified.ok, true);
    assert.strictEqual(verified.service.status, 'available');
    assert.strictEqual(httpsCaptures.length, 1);
    assert.strictEqual(
      httpsCaptures[0].options.headers.Authorization,
      'Bearer legacy-secret-for-smoke'
    );
    assert.ok(
      !JSON.stringify(verified).includes('legacy-secret-for-smoke'),
      'status must not leak a credential'
    );

    const jsonResult = await service.requestJson({
      requestId: 'summary-request',
      configFingerprint: verified.service.configFingerprint,
      messages: [{ role: 'user', content: 'test only' }],
    });
    assert.strictEqual(jsonResult.ok, true);
    assert.deepStrictEqual(jsonResult.data, { ok: true });
    assert.strictEqual(httpsCaptures.length, 2);

    const changed = service.saveConfig({
      config: providerConfig('deepseek', {
        model: 'changed-model',
        baseUrl: 'https://service.example.test/v1',
      }),
    });
    assert.strictEqual(changed.ok, true);
    assert.strictEqual(changed.service.status, 'pending');
    const stale = await service.requestJson({
      requestId: 'stale-request',
      configFingerprint: verified.service.configFingerprint,
      messages: [],
    });
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.code, 'configuration-unverified');

    const remoteHttp = service.saveConfig({
      config: providerConfig('custom', {
        baseUrl: 'http://remote.example.test/v1',
        model: 'test',
      }),
    });
    assert.strictEqual(remoteHttp.ok, false);
    assert.strictEqual(remoteHttp.code, 'insecure-endpoint');
    assert.strictEqual(httpCaptures.length, 0, 'remote HTTP must fail before transport');

    const local = await service.testConnection({
      config: providerConfig('local', {
        baseUrl: 'http://127.0.0.1:11434/v1',
        authStrategy: 'none',
      }),
      requestId: 'verify-local',
    });
    assert.strictEqual(local.ok, true);
    assert.strictEqual(local.service.status, 'available');
    assert.strictEqual(httpCaptures.length, 1);
    assert.ok(!httpCaptures[0].options.headers.Authorization);

    async function expectTestFailure(status, body, code) {
      const isolated = managerModule.createAiServiceManager({
        configStore: new MemoryStore(),
        safeStorage: createSafeStorage(true),
        transports: {
          https: createTransport([errorPlan(status, body)], []),
          http: createTransport([], []),
        },
      });
      const result = await isolated.testConnection({
        config: providerConfig('openai'),
        key: 'smoke-key',
        requestId: 'failure-' + status,
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.code, code);
      assert.strictEqual(result.service.status, 'failed');
    }
    await expectTestFailure(401, '{}', 'unauthorized');
    await expectTestFailure(404, '{}', 'endpoint-not-found');
    await expectTestFailure(429, '{}', 'rate-limited');
    await expectTestFailure(400, 'response_format is not supported', 'json-mode-unsupported');

    const badJson = managerModule.createAiServiceManager({
      configStore: new MemoryStore(),
      safeStorage: createSafeStorage(true),
      transports: {
        https: createTransport(
          [({ onResponse }) => loadResponse(onResponse, 200, '{not-json')],
          []
        ),
        http: createTransport([], []),
      },
    });
    const badJsonResult = await badJson.testConnection({
      config: providerConfig('openai'),
      key: 'smoke-key',
      requestId: 'bad-json',
    });
    assert.strictEqual(badJsonResult.ok, false);
    assert.strictEqual(badJsonResult.code, 'invalid-json');

    const timeout = managerModule.createAiServiceManager({
      configStore: new MemoryStore(),
      safeStorage: createSafeStorage(true),
      transports: {
        https: createTransport([() => {}], []),
        http: createTransport([], []),
      },
    });
    const timeoutResult = await timeout.testConnection({
      config: providerConfig('openai'),
      key: 'smoke-key',
      requestId: 'timeout',
      timeoutMs: 1,
    });
    assert.strictEqual(timeoutResult.ok, false);
    assert.strictEqual(timeoutResult.code, 'timeout');

    let hangingRequest = null;
    const cancelService = managerModule.createAiServiceManager({
      configStore: new MemoryStore(),
      safeStorage: createSafeStorage(true),
      transports: {
        https: createTransport(
          [({ request }) => {
            hangingRequest = request;
          }],
          []
        ),
        http: createTransport([], []),
      },
    });
    const pending = cancelService.testConnection({
      config: providerConfig('openai'),
      key: 'smoke-key',
      requestId: 'cancel-test',
    });
    assert.strictEqual(cancelService.cancelRequest('cancel-test'), true);
    const canceled = await pending;
    assert.strictEqual(canceled.ok, false);
    assert.strictEqual(canceled.code, 'canceled');
    assert.strictEqual(hangingRequest.destroyed, true);

    const unavailableStore = new MemoryStore();
    const unavailable = managerModule.createAiServiceManager({
      configStore: unavailableStore,
      safeStorage: createSafeStorage(false),
      transports: { https: createTransport([], []), http: createTransport([], []) },
    });
    const unavailableMigration = unavailable.migrateLegacy({
      legacy: true,
      legacyKey: 'keep-legacy-until-safe-storage-works',
      config: providerConfig('deepseek'),
    });
    assert.strictEqual(unavailableMigration.ok, false);
    assert.strictEqual(unavailableMigration.preserveLegacy, true);
    assert.strictEqual(unavailableStore.get('credential'), undefined);

    const legacyWithoutKey = managerModule.createAiServiceManager({
      configStore: new MemoryStore(),
      safeStorage: createSafeStorage(true),
      transports: { https: createTransport([], []), http: createTransport([], []) },
    });
    const migratedPublicConfig = legacyWithoutKey.migrateLegacy({
      legacy: true,
      legacyKey: '',
      config: providerConfig('deepseek', {
        model: 'legacy-model',
        baseUrl: 'https://legacy.example.test/v1',
      }),
    });
    assert.strictEqual(migratedPublicConfig.ok, true);
    assert.strictEqual(migratedPublicConfig.migrated, true);
    assert.strictEqual(migratedPublicConfig.service.model, 'legacy-model');
    assert.strictEqual(
      migratedPublicConfig.service.baseUrl,
      'https://legacy.example.test/v1'
    );
    assert.strictEqual(migratedPublicConfig.service.status, 'unconfigured');

    const rendererSeed = fs.readFileSync(
      path.join(root, 'src/store/initLocalStorage.js'),
      'utf8'
    );
    const settingsBridge = fs.readFileSync(
      path.join(root, 'src/store/plugins/sendSettings.js'),
      'utf8'
    );
    const backupSource = fs.readFileSync(
      path.join(root, 'src/utils/podcast/backup.js'),
      'utf8'
    );
    const settingsSource = fs.readFileSync(
      path.join(root, 'src/views/settings.vue'),
      'utf8'
    );
    assert.ok(!rendererSeed.includes('deepseekKey'));
    assert.ok(settingsBridge.includes('delete settings.deepseekKey'));
    assert.ok(!backupSource.includes('aiService'));
    assert.ok(!settingsSource.includes('v-model="deepseekKey"'));
    assert.ok(settingsSource.includes('测试连接'));
    process.stdout.write('ai provider settings smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
