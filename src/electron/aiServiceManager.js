// Main-process owner for the one active networking AI service. The renderer
// receives only public configuration and asks this module to make requests; an
// API key never needs to live in Vuex, localStorage, backups, or UI errors.
import { ipcMain, safeStorage } from 'electron';
import Store from 'electron-store';
import { createHash } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { createWindowsDpapiProtector } from './windowsDpapi';
import {
  AI_SERVICE_SCHEMA_VERSION,
  createAiProviderPresetConfig,
  getAiCredentialScope,
  hasSameAiCredentialScope,
  isAiServiceReady,
  normalizeAiServiceConfig,
  publicAiServiceConfig,
  resolveOpenAiChatUrl,
} from '../utils/podcast/aiServiceConfig';

const STORE_CONFIG_KEY = 'config';
const STORE_CREDENTIAL_KEY = 'credential';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 90000;
const DEFAULT_TEST_TIMEOUT_MS = 12000;

export class AiServiceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AiServiceError';
    this.code = code || 'request-failed';
    if (details && details.status) this.status = details.status;
  }
}

function createError(code, message, details) {
  return new AiServiceError(code, message, details);
}

function utf8Length(value) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function cleanString(value) {
  return String(value == null ? '' : value).trim();
}

function maskKey(value) {
  const key = cleanString(value);
  if (!key) return '';
  return '****' + key.slice(-4);
}

function safeErrorResult(error) {
  const e = error || {};
  return {
    ok: false,
    code: e.code || 'request-failed',
    error: e.message || '联网 AI 服务操作失败',
  };
}

function createElectronSafeStorageProtector(safeStorageImpl) {
  return {
    id: 'electron-safe-storage-v1',
    isAvailable() {
      const probe = 'podplayer-ai-safe-storage-probe-v1';
      try {
        if (
          !safeStorageImpl ||
          typeof safeStorageImpl.encryptString !== 'function' ||
          typeof safeStorageImpl.decryptString !== 'function'
        ) {
          return false;
        }
        const ciphertext = safeStorageImpl.encryptString(probe);
        return safeStorageImpl.decryptString(ciphertext) === probe;
      } catch (e) {
        return false;
      }
    },
    protect(value) {
      return safeStorageImpl.encryptString(value).toString('base64');
    },
    unprotect(ciphertext) {
      return safeStorageImpl.decryptString(Buffer.from(ciphertext, 'base64'));
    },
  };
}

function keyDigest(value) {
  return createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex');
}

function fingerprintFor(config, key) {
  const c = normalizeAiServiceConfig(config);
  const payload = [
    AI_SERVICE_SCHEMA_VERSION,
    c.provider,
    c.model,
    c.baseUrl,
    c.authStrategy,
    c.jsonMode,
    c.authStrategy === 'none' ? '' : keyDigest(key),
  ].join('\n');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function classifyHttpError(status, body, usesJsonMode) {
  if (status === 401 || status === 403) {
    return createError('unauthorized', 'API 密钥无效或没有访问权限', {
      status,
    });
  }
  if (status === 404) {
    return createError('endpoint-not-found', '服务地址或模型接口不存在', {
      status,
    });
  }
  if (status === 429) {
    return createError('rate-limited', 'AI 服务请求过于频繁，请稍后重试', {
      status,
    });
  }
  const normalized = String(body || '').toLowerCase();
  if (
    usesJsonMode &&
    /(response_format|json[_ -]?mode|json[_ -]?object)/.test(normalized)
  ) {
    return createError(
      'json-mode-unsupported',
      '当前模型不支持 JSON 输出，请更换模型或服务',
      { status }
    );
  }
  if (status === 400 || status === 422) {
    return createError('model-or-request', '模型标识或请求参数不被服务接受', {
      status,
    });
  }
  return createError('http', 'AI 服务请求失败，请稍后重试', { status });
}

function responseContent(response) {
  const choices = response && response.choices;
  const message = choices && choices[0] && choices[0].message;
  const content = message && message.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw createError('invalid-response', 'AI 服务未返回可用内容');
  }
  return content;
}

function normalizeTimeout(value, fallback) {
  const number = Number(value);
  return Math.max(
    250,
    Math.min(Number.isFinite(number) ? number : fallback, 120000)
  );
}

export function createAiServiceManager(options) {
  const opts = options || {};
  const ipc = opts.ipcMain || ipcMain;
  const secureStorage = opts.safeStorage || safeStorage;
  const configStore =
    opts.configStore || new Store({ name: 'podplayer-ai-service' });
  const transports = opts.transports || { http, https };
  const now = opts.now || (() => Date.now());
  const platform = opts.platform || process.platform;
  const activeRequests = new Map();
  const electronCredentialProtector =
    createElectronSafeStorageProtector(secureStorage);
  const windowsDpapiProtector =
    opts.windowsDpapiProtector ||
    createWindowsDpapiProtector({
      platform,
      powerShellPath: opts.powerShellPath,
      spawnSync: opts.spawnSync,
    });
  let electronCredentialBackendReady = false;
  let windowsDpapiBackendReady = false;
  let credentialCache = null;

  function availableElectronCredentialBackend() {
    if (electronCredentialBackendReady) return electronCredentialProtector;
    if (!electronCredentialProtector.isAvailable()) return null;
    electronCredentialBackendReady = true;
    return electronCredentialProtector;
  }

  function availableWindowsDpapiBackend() {
    if (platform !== 'win32') return null;
    if (windowsDpapiBackendReady) return windowsDpapiProtector;
    if (
      !windowsDpapiProtector ||
      typeof windowsDpapiProtector.isAvailable !== 'function' ||
      !windowsDpapiProtector.isAvailable()
    ) {
      return null;
    }
    windowsDpapiBackendReady = true;
    return windowsDpapiProtector;
  }

  function credentialBackendFor(record) {
    const backend = record && record.backend;
    if (backend === 'electron-safe-storage-v1') {
      return availableElectronCredentialBackend();
    }
    if (backend === 'windows-dpapi-v1') {
      return availableWindowsDpapiBackend();
    }
    // Legacy records did not record a backend. Prefer Electron's API when it
    // exists, then use the Windows-only DPAPI compatibility backend.
    return (
      availableElectronCredentialBackend() || availableWindowsDpapiBackend()
    );
  }

  function readStoredConfig() {
    const raw = configStore.get(STORE_CONFIG_KEY);
    if (!raw || typeof raw !== 'object')
      return createAiProviderPresetConfig('deepseek');
    return normalizeAiServiceConfig(raw);
  }

  function hasStoredConfig() {
    const raw = configStore.get(STORE_CONFIG_KEY);
    return !!raw && typeof raw === 'object';
  }

  function readCredentialRecord() {
    const record = configStore.get(STORE_CREDENTIAL_KEY);
    return record && typeof record === 'object' ? record : null;
  }

  function credentialCacheId(record) {
    return [
      record && record.backend,
      record && record.updatedAt,
      record && record.ciphertext,
      record && record.scope ? JSON.stringify(record.scope) : '',
    ].join(':');
  }

  function clearCredentialCache() {
    credentialCache = null;
  }

  function cloneStoredValue(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function snapshotStoredState() {
    return {
      config: cloneStoredValue(configStore.get(STORE_CONFIG_KEY)),
      credential: cloneStoredValue(configStore.get(STORE_CREDENTIAL_KEY)),
    };
  }

  function sameStoredState(snapshot) {
    return (
      JSON.stringify(configStore.get(STORE_CONFIG_KEY)) ===
        JSON.stringify(snapshot.config) &&
      JSON.stringify(configStore.get(STORE_CREDENTIAL_KEY)) ===
        JSON.stringify(snapshot.credential)
    );
  }

  function restoreStoredState(snapshot) {
    if (snapshot.config === undefined) {
      configStore.delete(STORE_CONFIG_KEY);
    } else {
      configStore.set(STORE_CONFIG_KEY, snapshot.config);
    }
    if (snapshot.credential === undefined) {
      configStore.delete(STORE_CREDENTIAL_KEY);
    } else {
      configStore.set(STORE_CREDENTIAL_KEY, snapshot.credential);
    }
    clearCredentialCache();
  }

  function scopeMismatchError() {
    return createError(
      'credential-scope-mismatch',
      '已切换服务，请填写该服务的 API 密钥'
    );
  }

  function readKey(config, options) {
    const record = readCredentialRecord();
    if (!record || !record.ciphertext) return '';
    const normalized = normalizeAiServiceConfig(config);
    const expectedScope = getAiCredentialScope(normalized);
    const allowLegacyScopeMigration =
      options && options.allowLegacyScopeMigration === true;
    if (
      record.scope &&
      !hasSameAiCredentialScope(record.scope, expectedScope)
    ) {
      throw scopeMismatchError();
    }
    if (!record.scope && !allowLegacyScopeMigration) {
      throw scopeMismatchError();
    }
    const cacheId = credentialCacheId(record);
    if (record.scope && credentialCache && credentialCache.id === cacheId) {
      return credentialCache.key;
    }
    const backend = credentialBackendFor(record);
    if (!backend) {
      throw createError(
        'safe-storage-unavailable',
        '系统凭据保护不可用，已保留原配置且未发起联网请求'
      );
    }
    try {
      const key = cleanString(backend.unprotect(record.ciphertext));
      let activeRecord = record;
      if (!record.scope) {
        activeRecord = { ...record, scope: expectedScope };
        // Legacy ciphertext has no service binding. It is only ever bound to
        // the already-saved configuration after successful local decryption;
        // this migration never makes a network request.
        configStore.set(STORE_CREDENTIAL_KEY, activeRecord);
      }
      credentialCache = { id: credentialCacheId(activeRecord), key };
      return key;
    } catch (e) {
      throw createError(
        'credential-unavailable',
        '无法读取已保存的 API 密钥，请重新配置后再测试连接'
      );
    }
  }

  function publicState(config, key, options) {
    const normalized = normalizeAiServiceConfig(config);
    const usableKey =
      normalized.authStrategy === 'none'
        ? ''
        : key === undefined
        ? readKey(normalized, options)
        : key;
    const fingerprint = isAiServiceReady({
      ...normalized,
      hasKey: normalized.authStrategy === 'none' || !!usableKey,
    })
      ? fingerprintFor(normalized, usableKey)
      : '';
    const status =
      normalized.status === 'available' &&
      normalized.configFingerprint &&
      normalized.configFingerprint === fingerprint
        ? 'available'
        : normalized.status === 'failed'
        ? 'failed'
        : fingerprint
        ? 'pending'
        : 'unconfigured';
    return publicAiServiceConfig({
      ...normalized,
      hasKey: normalized.authStrategy === 'none' || !!usableKey,
      maskedKey: usableKey ? maskKey(usableKey) : '',
      status,
      verifiedAt: status === 'available' ? normalized.verifiedAt : 0,
      configFingerprint: fingerprint,
      errorCode: status === 'failed' ? normalized.errorCode : '',
    });
  }

  function getStatus() {
    try {
      return {
        ok: true,
        service: publicState(readStoredConfig(), undefined, {
          allowLegacyScopeMigration: hasStoredConfig(),
        }),
      };
    } catch (error) {
      const config = readStoredConfig();
      return {
        ok: false,
        ...safeErrorResult(error),
        service: publicAiServiceConfig({
          ...config,
          status: 'unavailable',
          errorCode: (error && error.code) || 'credential-unavailable',
        }),
      };
    }
  }

  function createCredentialRecord(key, config) {
    const backend = credentialBackendFor();
    if (!backend) {
      throw createError(
        'safe-storage-unavailable',
        '系统凭据保护不可用，已保留原配置且未保存 API 密钥'
      );
    }
    let ciphertext = '';
    try {
      ciphertext = backend.protect(key);
      if (!ciphertext) throw new Error('empty-ciphertext');
      return {
        schemaVersion: AI_SERVICE_SCHEMA_VERSION,
        backend: backend.id,
        ciphertext,
        scope: getAiCredentialScope(config),
        updatedAt: now(),
      };
    } catch (e) {
      if (e && e.code) throw e;
      throw createError(
        'safe-storage-failed',
        '无法写入系统凭据保护，已保留原配置'
      );
    }
  }

  function writeCredential(key, config) {
    const record = createCredentialRecord(key, config);
    configStore.set(STORE_CREDENTIAL_KEY, record);
    credentialCache = {
      id: credentialCacheId(record),
      key,
    };
  }

  function resolveCandidateKey(input, config) {
    const incomingKey = cleanString(input && input.key);
    if (config.authStrategy === 'none') {
      return { key: '', hasIncomingKey: false };
    }
    if (incomingKey) return { key: incomingKey, hasIncomingKey: true };

    const record = readCredentialRecord();
    if (record && !record.scope) {
      const stored = readStoredConfig();
      if (!hasStoredConfig() || !hasSameAiCredentialScope(stored, config)) {
        throw scopeMismatchError();
      }
      return {
        key: readKey(stored, { allowLegacyScopeMigration: true }),
        hasIncomingKey: false,
      };
    }
    return { key: readKey(config), hasIncomingKey: false };
  }

  function prepareConnectionCandidate(payload) {
    const input = payload || {};
    const config = normalizeAiServiceConfig(input.config || input);
    resolveOpenAiChatUrl(config.baseUrl);
    const credential = resolveCandidateKey(input, config);
    const hasKey = config.authStrategy === 'none' || !!credential.key;
    if (!isAiServiceReady({ ...config, hasKey })) {
      throw createError('no-key', '请先填写 API 密钥或选择本地服务');
    }
    return {
      config,
      key: credential.key,
      hasIncomingKey: credential.hasIncomingKey,
      fingerprint: fingerprintFor(config, credential.key),
    };
  }

  function commitVerifiedCandidate(candidate, snapshot) {
    if (!sameStoredState(snapshot)) {
      throw createError(
        'configuration-stale',
        '联网 AI 配置已变更，请重新测试连接'
      );
    }
    const credential = candidate.hasIncomingKey
      ? createCredentialRecord(candidate.key, candidate.config)
      : null;
    const verified = {
      schemaVersion: AI_SERVICE_SCHEMA_VERSION,
      provider: candidate.config.provider,
      model: candidate.config.model,
      baseUrl: candidate.config.baseUrl,
      authStrategy: candidate.config.authStrategy,
      jsonMode: candidate.config.jsonMode,
      status: 'available',
      verifiedAt: now(),
      configFingerprint: candidate.fingerprint,
      errorCode: '',
      updatedAt: now(),
    };
    try {
      // Persist a fresh credential before making the matching configuration
      // available. If either write fails, restore both prior records.
      if (credential) configStore.set(STORE_CREDENTIAL_KEY, credential);
      configStore.set(STORE_CONFIG_KEY, verified);
      if (credential) {
        credentialCache = {
          id: credentialCacheId(credential),
          key: candidate.key,
        };
      }
      return { ok: true, service: publicState(verified, candidate.key) };
    } catch (error) {
      try {
        restoreStoredState(snapshot);
      } catch (rollbackError) {
        throw createError(
          'configuration-rollback-failed',
          '联网 AI 配置提交失败，且无法自动恢复原配置'
        );
      }
      throw createError(
        'configuration-commit-failed',
        '联网 AI 配置提交失败，已保留原配置'
      );
    }
  }

  function saveConfig(payload) {
    const input = payload || {};
    const config = normalizeAiServiceConfig(input.config || input);
    try {
      resolveOpenAiChatUrl(config.baseUrl);
    } catch (error) {
      return {
        ok: false,
        ...safeErrorResult(error),
        service: getStatus().service,
      };
    }
    const hasIncomingKey =
      Object.prototype.hasOwnProperty.call(input, 'key') &&
      cleanString(input.key);
    let key = '';
    try {
      if (hasIncomingKey) {
        key = cleanString(input.key);
        writeCredential(key, config);
      } else if (input.clearKey === true) {
        configStore.delete(STORE_CREDENTIAL_KEY);
        clearCredentialCache();
      } else if (config.authStrategy !== 'none') {
        const record = readCredentialRecord();
        if (record && !record.scope) {
          // An unscoped legacy record may only be attached to the configuration
          // already stored before this save. Never bind it to a new draft.
          if (!hasStoredConfig()) throw scopeMismatchError();
          readKey(readStoredConfig(), { allowLegacyScopeMigration: true });
        }
        key = readKey(config);
      }
    } catch (error) {
      return { ok: false, ...safeErrorResult(error), preserveLegacy: true };
    }

    if (config.authStrategy === 'none') key = '';
    const hasKey = config.authStrategy === 'none' || !!key;
    const fingerprint = hasKey ? fingerprintFor(config, key) : '';
    const previous = readStoredConfig();
    const keepVerified =
      previous.status === 'available' &&
      previous.configFingerprint === fingerprint;
    const stored = {
      schemaVersion: AI_SERVICE_SCHEMA_VERSION,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      authStrategy: config.authStrategy,
      jsonMode: config.jsonMode,
      status: hasKey
        ? keepVerified
          ? 'available'
          : 'pending'
        : 'unconfigured',
      verifiedAt: keepVerified ? previous.verifiedAt : 0,
      configFingerprint: fingerprint,
      errorCode: '',
      updatedAt: now(),
    };
    configStore.set(STORE_CONFIG_KEY, stored);
    return { ok: true, service: publicState(stored, key) };
  }

  function migrateLegacy(payload) {
    const input = payload || {};
    const hasLegacyConfig = input.legacy === true;
    const existing = getStatus();
    if (existing.ok && existing.service && existing.service.hasKey) {
      return {
        ok: true,
        migrated: false,
        legacyHandled: hasLegacyConfig,
        service: existing.service,
      };
    }
    const legacyKey = cleanString(input.legacyKey);
    if (!hasLegacyConfig) {
      return { ok: true, migrated: false, service: existing.service };
    }
    const result = saveConfig({ config: input.config, key: legacyKey });
    if (!result.ok) {
      return { ...result, migrated: false, preserveLegacy: true };
    }
    return { ...result, migrated: true, legacyHandled: true };
  }

  function deleteCredential() {
    const current = readStoredConfig();
    configStore.delete(STORE_CREDENTIAL_KEY);
    clearCredentialCache();
    const stored = {
      ...current,
      status: current.authStrategy === 'none' ? 'pending' : 'unconfigured',
      verifiedAt: 0,
      configFingerprint: '',
      errorCode: '',
      updatedAt: now(),
    };
    configStore.set(STORE_CONFIG_KEY, stored);
    return { ok: true, service: publicState(stored, '') };
  }

  function cancelRequest(requestId) {
    const id = cleanString(requestId);
    const active = id && activeRequests.get(id);
    if (!active) return false;
    active.canceled = true;
    if (active.req && typeof active.req.destroy === 'function') {
      active.req.destroy();
    }
    if (typeof active.finishCanceled === 'function') active.finishCanceled();
    return true;
  }

  function requestChat(config, key, messages, options) {
    const requestOptions = options || {};
    const requestId = cleanString(requestOptions.requestId);
    let url;
    try {
      url = resolveOpenAiChatUrl(config.baseUrl);
    } catch (error) {
      return Promise.reject(error);
    }
    const transport =
      url.protocol === 'http:' ? transports.http : transports.https;
    if (!transport || typeof transport.request !== 'function') {
      return Promise.reject(createError('network', 'AI 服务连接失败'));
    }
    const bodyObject = {
      model: config.model,
      messages: Array.isArray(messages) ? messages : [],
      temperature:
        requestOptions.temperature == null ? 0.2 : requestOptions.temperature,
    };
    if (config.jsonMode === 'response-format') {
      bodyObject.response_format = { type: 'json_object' };
    }
    const body = JSON.stringify(bodyObject);
    const timeoutMs = normalizeTimeout(
      requestOptions.timeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;
      const active = { req: null, canceled: false, finishCanceled: null };
      if (requestId) activeRequests.set(requestId, active);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (requestId && activeRequests.get(requestId) === active) {
          activeRequests.delete(requestId);
        }
        if (error) reject(error);
        else resolve(value);
      };
      const canceled = () => active.canceled === true;
      active.finishCanceled = () =>
        finish(createError('canceled', '已取消 AI 请求'));
      try {
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': utf8Length(body),
        };
        if (config.authStrategy !== 'none')
          headers.Authorization = 'Bearer ' + key;
        active.req = transport.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + (url.search || ''),
            method: 'POST',
            headers,
          },
          response => {
            let responseBody = '';
            let bytes = 0;
            if (response && response.setEncoding) response.setEncoding('utf8');
            response.on('data', chunk => {
              if (settled) return;
              bytes += utf8Length(chunk);
              if (bytes > MAX_RESPONSE_BYTES) {
                if (response.destroy) response.destroy();
                finish(createError('response-too-large', 'AI 服务响应过大'));
                return;
              }
              responseBody += chunk;
            });
            response.on('error', () => {
              finish(
                canceled()
                  ? createError('canceled', '已取消 AI 请求')
                  : createError('network', 'AI 服务连接中断')
              );
            });
            response.on('end', () => {
              if (settled) return;
              if (canceled()) {
                finish(createError('canceled', '已取消 AI 请求'));
                return;
              }
              const status = Number(response && response.statusCode) || 0;
              if (status < 200 || status >= 300) {
                finish(
                  classifyHttpError(
                    status,
                    responseBody,
                    config.jsonMode === 'response-format'
                  )
                );
                return;
              }
              try {
                finish(null, JSON.parse(responseBody));
              } catch (e) {
                finish(
                  createError('invalid-json', 'AI 服务返回了无法识别的数据')
                );
              }
            });
          }
        );
      } catch (error) {
        finish(createError('network', 'AI 服务连接失败'));
        return;
      }
      active.req.on('error', () => {
        if (settled) return;
        finish(
          canceled()
            ? createError('canceled', '已取消 AI 请求')
            : createError('network', 'AI 服务连接失败')
        );
      });
      timeoutId = setTimeout(() => {
        if (active.req && active.req.destroy) active.req.destroy();
        finish(createError('timeout', 'AI 服务请求超时'));
      }, timeoutMs);
      active.req.write(body, 'utf8');
      active.req.end();
    });
  }

  function currentVerifiedConfig(fingerprint) {
    const config = readStoredConfig();
    const key =
      config.authStrategy === 'none'
        ? ''
        : readKey(config, { allowLegacyScopeMigration: true });
    const publicConfig = publicState(config, key);
    if (!isAiServiceReady(publicConfig)) {
      throw createError('no-key', '请先配置联网 AI 服务');
    }
    if (publicConfig.status !== 'available') {
      throw createError('configuration-unverified', '请先测试联网 AI 服务连接');
    }
    if (
      fingerprint &&
      (!publicConfig.configFingerprint ||
        fingerprint !== publicConfig.configFingerprint)
    ) {
      throw createError(
        'configuration-stale',
        '联网 AI 配置已变更，请重新测试连接'
      );
    }
    return { config, key, publicConfig };
  }

  async function requestJson(payload) {
    try {
      const input = payload || {};
      const current = currentVerifiedConfig(input.configFingerprint);
      const response = await requestChat(
        current.config,
        current.key,
        input.messages,
        {
          requestId: input.requestId,
          temperature: input.temperature,
          timeoutMs: input.timeoutMs,
        }
      );
      const content = responseContent(response);
      let data;
      try {
        data = JSON.parse(content);
      } catch (e) {
        throw createError('invalid-json', 'AI 服务返回了无法识别的数据');
      }
      return {
        ok: true,
        data,
        usage: (response && response.usage) || {},
        provider: resolveOpenAiChatUrl(current.config.baseUrl).hostname,
        model: current.config.model,
      };
    } catch (error) {
      return safeErrorResult(error);
    }
  }

  async function testConnection(payload) {
    const input = payload || {};
    let candidate;
    try {
      candidate = prepareConnectionCandidate(input);
    } catch (error) {
      return { ...safeErrorResult(error), service: getStatus().service };
    }
    const snapshot = snapshotStoredState();
    try {
      const response = await requestChat(
        candidate.config,
        candidate.key,
        [
          {
            role: 'system',
            content: 'Return only a JSON object with a boolean ok field.',
          },
          { role: 'user', content: 'Return {"ok":true}.' },
        ],
        {
          requestId: input.requestId,
          timeoutMs: normalizeTimeout(input.timeoutMs, DEFAULT_TEST_TIMEOUT_MS),
          temperature: 0,
        }
      );
      const parsed = JSON.parse(responseContent(response));
      if (!parsed || parsed.ok !== true) {
        throw createError('invalid-json', 'AI 服务未返回预期的测试结果');
      }
      return commitVerifiedCandidate(candidate, snapshot);
    } catch (error) {
      return {
        ...safeErrorResult(error),
        // A candidate test never changes the active service on failure,
        // timeout, or cancellation. The renderer keeps its draft for retry.
        service: getStatus().service,
      };
    }
  }

  function register() {
    ipc.handle('ai:service:status', async () => getStatus());
    ipc.handle('ai:service:initialize', async (_event, payload) => {
      try {
        return migrateLegacy(payload);
      } catch (error) {
        return safeErrorResult(error);
      }
    });
    ipc.handle('ai:service:saveConfig', async (_event, payload) => {
      try {
        return saveConfig(payload);
      } catch (error) {
        return safeErrorResult(error);
      }
    });
    ipc.handle('ai:service:deleteKey', async () => {
      try {
        return deleteCredential();
      } catch (error) {
        return safeErrorResult(error);
      }
    });
    ipc.handle('ai:service:testConnection', async (_event, payload) => {
      return testConnection(payload);
    });
    ipc.handle('ai:service:requestJson', async (_event, payload) => {
      return requestJson(payload);
    });
    ipc.on('ai:service:cancelRequest', (_event, payload) => {
      cancelRequest(payload && payload.requestId);
    });
  }

  function shutdown() {
    Array.from(activeRequests.keys()).forEach(cancelRequest);
    clearCredentialCache();
  }

  return {
    getStatus,
    saveConfig,
    migrateLegacy,
    deleteCredential,
    cancelRequest,
    requestJson,
    testConnection,
    register,
    shutdown,
    _debug: { activeRequests },
  };
}

let defaultManager = null;

export function registerAiServiceIpc() {
  if (defaultManager) return defaultManager;
  defaultManager = createAiServiceManager();
  defaultManager.register();
  return defaultManager;
}

export function shutdownAiServiceManager() {
  if (defaultManager) defaultManager.shutdown();
  defaultManager = null;
}
