// Public, provider-neutral configuration for the single active networking AI
// service. Credentials intentionally never belong in this module or in Vuex.

export const AI_SERVICE_SCHEMA_VERSION = 1;

export const AI_PROVIDER_PRESETS = Object.freeze({
  deepseek: Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    authStrategy: 'bearer',
    jsonMode: 'response-format',
    officialPreset: true,
  }),
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    authStrategy: 'bearer',
    jsonMode: 'response-format',
    officialPreset: true,
  }),
  gemini: Object.freeze({
    id: 'gemini',
    label: 'Gemini（OpenAI 兼容）',
    model: 'gemini-3.6-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authStrategy: 'bearer',
    jsonMode: 'response-format',
    officialPreset: true,
  }),
  openrouter: Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    model: 'openai/gpt-4.1-mini',
    baseUrl: 'https://openrouter.ai/api/v1',
    authStrategy: 'bearer',
    jsonMode: 'response-format',
    officialPreset: true,
  }),
  local: Object.freeze({
    id: 'local',
    label: '本地服务（Ollama / LM Studio）',
    model: 'gpt-oss:20b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    authStrategy: 'none',
    jsonMode: 'response-format',
    officialPreset: true,
  }),
  custom: Object.freeze({
    id: 'custom',
    label: '自定义 OpenAI 兼容服务',
    model: '',
    baseUrl: '',
    authStrategy: 'bearer',
    jsonMode: 'response-format',
    officialPreset: false,
  }),
});

export const AI_PROVIDER_ORDER = Object.freeze([
  'deepseek',
  'openai',
  'gemini',
  'openrouter',
  'local',
  'custom',
]);

function trimText(value) {
  return String(value == null ? '' : value).trim();
}

function trimTrailingSlash(value) {
  return trimText(value).replace(/\/+$/, '');
}

export function getAiProviderPreset(provider) {
  return AI_PROVIDER_PRESETS[provider] || AI_PROVIDER_PRESETS.deepseek;
}

export function getAiProviderOptions() {
  return AI_PROVIDER_ORDER.map(id => getAiProviderPreset(id));
}

export function normalizeAiServiceConfig(input) {
  const raw = input || {};
  const preset = getAiProviderPreset(raw.provider);
  const provider = AI_PROVIDER_PRESETS[raw.provider] ? raw.provider : preset.id;
  const authStrategy =
    raw.authStrategy === 'none' || preset.authStrategy === 'none'
      ? 'none'
      : 'bearer';
  const jsonMode =
    raw.jsonMode === 'prompt-only' ? 'prompt-only' : 'response-format';
  return {
    schemaVersion: AI_SERVICE_SCHEMA_VERSION,
    provider,
    model: trimText(raw.model) || preset.model,
    baseUrl: trimTrailingSlash(raw.baseUrl) || preset.baseUrl,
    authStrategy,
    jsonMode,
    hasKey: raw.hasKey === true,
    maskedKey: trimText(raw.maskedKey),
    verifiedAt: Number(raw.verifiedAt) || 0,
    configFingerprint: trimText(raw.configFingerprint),
    status: trimText(raw.status) || 'unconfigured',
    errorCode: trimText(raw.errorCode),
  };
}

export function createAiProviderPresetConfig(provider) {
  return normalizeAiServiceConfig({ provider });
}

export function isLoopbackHost(hostname) {
  const host = trimText(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function resolveOpenAiChatUrl(baseUrl) {
  let url;
  try {
    url = new URL(trimText(baseUrl));
  } catch (e) {
    const error = new Error('AI 服务地址无效');
    error.code = 'invalid-endpoint';
    throw error;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    const error = new Error('AI 服务地址无效');
    error.code = 'invalid-endpoint';
    throw error;
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    const error = new Error('仅允许使用 HTTPS 服务地址；HTTP 仅限本机服务');
    error.code = 'insecure-endpoint';
    throw error;
  }
  const path = (url.pathname || '').replace(/\/+$/, '');
  if (!/\/chat\/completions$/i.test(path)) {
    url.pathname = (path || '') + '/chat/completions';
  }
  return url;
}

export function isAiServiceReady(config) {
  const normalized = normalizeAiServiceConfig(config);
  if (!normalized.model || !normalized.baseUrl) return false;
  if (normalized.authStrategy === 'none') return true;
  return normalized.hasKey;
}

export function canUseVerifiedAiService(config) {
  const normalized = normalizeAiServiceConfig(config);
  return isAiServiceReady(normalized) && normalized.status === 'available';
}

export function legacyDeepSeekConfig(settings) {
  const source = settings || {};
  return {
    key: trimText(source.deepseekKey),
    config: normalizeAiServiceConfig({
      provider: 'deepseek',
      model: source.deepseekModel,
      baseUrl: source.deepseekEndpoint,
    }),
  };
}

export function publicAiServiceConfig(config) {
  const normalized = normalizeAiServiceConfig(config);
  return {
    schemaVersion: AI_SERVICE_SCHEMA_VERSION,
    provider: normalized.provider,
    model: normalized.model,
    baseUrl: normalized.baseUrl,
    authStrategy: normalized.authStrategy,
    jsonMode: normalized.jsonMode,
    hasKey: normalized.hasKey,
    maskedKey: normalized.maskedKey,
    verifiedAt: normalized.verifiedAt,
    configFingerprint: normalized.configFingerprint,
    status: normalized.status,
    errorCode: normalized.errorCode,
  };
}
