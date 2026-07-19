// OpenAI-compatible JSON request helper shared by AI refinement and episode
// summaries. It deliberately keeps provider response bodies out of UI errors.

export const DEFAULT_AI_TIMEOUT_MS = 90000;

export class OpenAiRequestError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OpenAiRequestError';
    this.code = code || 'request-failed';
    if (details && details.status) this.status = details.status;
  }
}

export function hasOpenAiKey(cfg) {
  return !!String((cfg && cfg.key) || '').trim();
}

function requestError(code, message, details) {
  return new OpenAiRequestError(code, message, details);
}

function getHttps(explicitHttps) {
  if (explicitHttps) return explicitHttps;
  try {
    return window.require('https');
  } catch (e) {
    throw requestError('desktop-only', '联网 AI 仅桌面版可用');
  }
}

export function resolveOpenAiChatUrl(endpoint) {
  const raw = String(endpoint || 'https://api.deepseek.com').trim();
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    throw requestError('invalid-endpoint', 'AI 服务地址无效');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw requestError('invalid-endpoint', 'AI 服务地址无效');
  }
  const path = (url.pathname || '').replace(/\/+$/, '');
  if (!/\/chat\/completions$/i.test(path)) {
    url.pathname = (path || '') + '/chat/completions';
  }
  return url;
}

function utf8Length(value) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }
  return unescape(encodeURIComponent(value)).length;
}

function responseContent(response) {
  const choices = response && response.choices;
  const message = choices && choices[0] && choices[0].message;
  const content = message && message.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw requestError('invalid-response', 'AI 服务未返回可用内容');
  }
  return content;
}

function isAbortSignal(signal) {
  return !!(signal && typeof signal.addEventListener === 'function');
}

// `options.https` is intentionally injectable for isolated smoke tests. The
// production call path always resolves Electron's Node https module above.
export function requestOpenAiChat(cfg, messages, options) {
  const opts = options || {};
  const signal = opts.signal;
  if (!hasOpenAiKey(cfg)) {
    return Promise.reject(requestError('no-key', '请先配置联网 AI 服务'));
  }
  if (signal && signal.aborted) {
    return Promise.reject(requestError('canceled', '已取消 AI 请求'));
  }
  let https;
  let url;
  try {
    https = getHttps(opts.https);
    url = resolveOpenAiChatUrl(cfg && cfg.endpoint);
  } catch (e) {
    return Promise.reject(e);
  }
  const payload = JSON.stringify({
    model: (cfg && cfg.model) || 'deepseek-chat',
    messages: messages || [],
    temperature: opts.temperature == null ? 0.2 : opts.temperature,
    response_format: { type: 'json_object' },
  });
  const timeoutMs = Math.max(1000, opts.timeoutMs || DEFAULT_AI_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    let req = null;
    let settled = false;
    let timeoutId = null;
    let abortHandler = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (isAbortSignal(signal) && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => {
      if (req && typeof req.destroy === 'function') {
        req.destroy();
      }
      finish(requestError('canceled', '已取消 AI 请求'));
    };
    abortHandler = abort;

    try {
      req = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + (url.search || ''),
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': utf8Length(payload),
            Authorization: 'Bearer ' + String((cfg && cfg.key) || ''),
          },
        },
        response => {
          let body = '';
          let bodyBytes = 0;
          const maxBodyBytes = 2 * 1024 * 1024;
          if (response && response.setEncoding) response.setEncoding('utf8');
          response.on('data', chunk => {
            if (settled) return;
            bodyBytes += utf8Length(String(chunk || ''));
            if (bodyBytes > maxBodyBytes) {
              if (response.destroy) response.destroy();
              finish(requestError('response-too-large', 'AI 服务响应过大'));
              return;
            }
            body += chunk;
          });
          response.on('error', () => {
            finish(requestError('network', 'AI 服务连接中断'));
          });
          response.on('end', () => {
            if (settled) return;
            if (
              !response.statusCode ||
              response.statusCode < 200 ||
              response.statusCode >= 300
            ) {
              finish(
                requestError('http', 'AI 服务请求失败', {
                  status: response.statusCode || 0,
                })
              );
              return;
            }
            try {
              finish(null, JSON.parse(body));
            } catch (e) {
              finish(
                requestError('invalid-json', 'AI 服务返回了无法识别的数据')
              );
            }
          });
        }
      );
    } catch (e) {
      finish(requestError('network', 'AI 服务连接失败'));
      return;
    }

    req.on('error', () => {
      if (settled) return;
      if (signal && signal.aborted) {
        finish(requestError('canceled', '已取消 AI 请求'));
        return;
      }
      finish(requestError('network', 'AI 服务连接失败'));
    });
    timeoutId = setTimeout(() => {
      if (req && req.destroy) req.destroy();
      finish(requestError('timeout', 'AI 服务请求超时'));
    }, timeoutMs);
    if (isAbortSignal(signal)) signal.addEventListener('abort', abortHandler);
    if (signal && signal.aborted) {
      abort();
      return;
    }
    req.write(payload, 'utf8');
    req.end();
  });
}

export async function requestOpenAiJson(cfg, messages, options) {
  const response = await requestOpenAiChat(cfg, messages, options);
  const content = responseContent(response);
  try {
    return {
      data: JSON.parse(content),
      usage: response && response.usage ? response.usage : {},
      provider: resolveOpenAiChatUrl(cfg && cfg.endpoint).hostname,
      model: (cfg && cfg.model) || 'deepseek-chat',
    };
  } catch (e) {
    if (e instanceof OpenAiRequestError) throw e;
    throw requestError('invalid-json', 'AI 服务返回了无法识别的数据');
  }
}
