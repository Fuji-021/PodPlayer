// Renderer facade for OpenAI-compatible JSON work. Network transport and the
// credential both live in the main process; this module only forwards messages
// through a cancelable IPC request.
import { cancelAiServiceRequest, nextAiRequestId } from './aiService';
import {
  canUseVerifiedAiService,
  resolveOpenAiChatUrl,
} from './aiServiceConfig';

export const DEFAULT_AI_TIMEOUT_MS = 90000;

export class OpenAiRequestError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OpenAiRequestError';
    this.code = code || 'request-failed';
    if (details && details.status) this.status = details.status;
  }
}

function requestError(code, message, details) {
  return new OpenAiRequestError(code, message, details);
}

export { resolveOpenAiChatUrl };

export function hasOpenAiKey(cfg) {
  return canUseVerifiedAiService(cfg || {});
}

function getIpcInvoke(options) {
  const opts = options || {};
  if (typeof opts.invoke === 'function') return opts.invoke;
  if (process.env.IS_ELECTRON !== true) return null;
  try {
    const electron = window.require('electron');
    return electron && electron.ipcRenderer && electron.ipcRenderer.invoke
      ? electron.ipcRenderer.invoke.bind(electron.ipcRenderer)
      : null;
  } catch (e) {
    return null;
  }
}

function isAbortSignal(signal) {
  return !!(signal && typeof signal.addEventListener === 'function');
}

function unavailableReason(cfg) {
  if (!cfg || !cfg.hasKey) return 'no-key';
  return 'configuration-unverified';
}

export function requestOpenAiChat(cfg, messages, options) {
  const opts = options || {};
  if (!hasOpenAiKey(cfg)) {
    const code = unavailableReason(cfg);
    return Promise.reject(
      requestError(
        code,
        code === 'no-key' ? '请先配置联网 AI 服务' : '请先测试联网 AI 服务连接'
      )
    );
  }
  const invoke = getIpcInvoke(opts);
  if (!invoke) {
    return Promise.reject(requestError('desktop-only', '联网 AI 仅桌面版可用'));
  }
  const signal = opts.signal;
  if (signal && signal.aborted) {
    return Promise.reject(requestError('canceled', '已取消 AI 请求'));
  }
  const requestId = opts.requestId || nextAiRequestId('ai-request');
  let settled = false;
  let abortHandler = null;
  const cleanup = () => {
    if (isAbortSignal(signal) && abortHandler) {
      signal.removeEventListener('abort', abortHandler);
    }
  };
  const cancel = () => {
    if (typeof opts.cancel === 'function') opts.cancel(requestId);
    else cancelAiServiceRequest(requestId);
  };
  return new Promise((resolve, reject) => {
    abortHandler = () => {
      if (settled) return;
      cancel();
      settled = true;
      cleanup();
      reject(requestError('canceled', '已取消 AI 请求'));
    };
    if (isAbortSignal(signal)) signal.addEventListener('abort', abortHandler);
    Promise.resolve(
      invoke('ai:service:requestJson', {
        requestId,
        configFingerprint: cfg.configFingerprint,
        messages: Array.isArray(messages) ? messages : [],
        temperature: opts.temperature,
        timeoutMs: opts.timeoutMs || DEFAULT_AI_TIMEOUT_MS,
      })
    )
      .then(result => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!result || result.ok !== true) {
          reject(
            requestError(
              (result && result.code) || 'request-failed',
              (result && result.error) || 'AI 服务请求失败'
            )
          );
          return;
        }
        resolve(result);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(requestError('network', 'AI 服务连接失败'));
      });
  });
}

export async function requestOpenAiJson(cfg, messages, options) {
  const result = await requestOpenAiChat(cfg, messages, options);
  return {
    data: result.data,
    usage: result.usage || {},
    provider: result.provider || '',
    model: result.model || (cfg && cfg.model) || '',
  };
}
