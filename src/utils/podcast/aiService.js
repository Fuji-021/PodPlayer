// Renderer-side IPC facade for the main-process AI service manager. This file
// deliberately carries only public configuration; API keys remain in a local
// input draft until the main process persists it through OS-backed credential
// protection. The renderer never receives the stored credential.
import {
  createAiProviderPresetConfig,
  legacyDeepSeekConfig,
  normalizeAiServiceConfig,
  publicAiServiceConfig,
} from './aiServiceConfig';

let requestSerial = 0;

function getIpcRenderer() {
  if (process.env.IS_ELECTRON !== true) return null;
  try {
    const electron = window.require('electron');
    return electron && electron.ipcRenderer;
  } catch (e) {
    return null;
  }
}

function unavailableResult() {
  return {
    ok: false,
    code: 'desktop-only',
    error: '联网 AI 仅桌面版可用',
  };
}

function applyService(store, service, clearLegacy) {
  if (!store || !service) return;
  store.commit('setAiServicePublicConfig', {
    service: publicAiServiceConfig(service),
    clearLegacy: clearLegacy === true,
  });
}

export function getAiServiceConfig(settings) {
  const source = (settings && settings.aiService) || {};
  return normalizeAiServiceConfig(source);
}

export function nextAiRequestId(prefix) {
  requestSerial += 1;
  return [prefix || 'ai', Date.now(), requestSerial].join('-');
}

export async function initializeAiServiceSettings(store) {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return unavailableResult();
  const settings = (store && store.state && store.state.settings) || {};
  const legacy = legacyDeepSeekConfig(settings);
  const hasLegacyConfig =
    !!legacy.key ||
    !!String(settings.deepseekModel || '').trim() ||
    !!String(settings.deepseekEndpoint || '').trim();
  const payload = {
    config: getAiServiceConfig(settings),
  };
  if (hasLegacyConfig) {
    payload.legacy = true;
    payload.legacyKey = legacy.key;
    payload.config = legacy.config;
  }
  try {
    const result = await ipcRenderer.invoke('ai:service:initialize', payload);
    if (result && result.service) {
      applyService(
        store,
        result.service,
        result.ok && result.legacyHandled === true
      );
    }
    return result || unavailableResult();
  } catch (e) {
    return unavailableResult();
  }
}

export async function getAiServiceStatus(store) {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return unavailableResult();
  try {
    const result = await ipcRenderer.invoke('ai:service:status');
    if (result && result.service) applyService(store, result.service, false);
    return result || unavailableResult();
  } catch (e) {
    return unavailableResult();
  }
}

export async function saveAiServiceConfig(store, config, key) {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return unavailableResult();
  const payload = { config: normalizeAiServiceConfig(config) };
  if (key) payload.key = String(key).trim();
  try {
    const result = await ipcRenderer.invoke('ai:service:saveConfig', payload);
    if (result && result.service) applyService(store, result.service, false);
    return result || unavailableResult();
  } catch (e) {
    return unavailableResult();
  }
}

export async function deleteAiServiceKey(store) {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return unavailableResult();
  try {
    const result = await ipcRenderer.invoke('ai:service:deleteKey');
    if (result && result.service) applyService(store, result.service, false);
    return result || unavailableResult();
  } catch (e) {
    return unavailableResult();
  }
}

export async function testAiServiceConnection(store, config, key, requestId) {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return unavailableResult();
  try {
    const result = await ipcRenderer.invoke('ai:service:testConnection', {
      config: normalizeAiServiceConfig(config),
      key: key ? String(key).trim() : '',
      requestId: requestId || nextAiRequestId('ai-test'),
    });
    if (result && result.service) applyService(store, result.service, false);
    return result || unavailableResult();
  } catch (e) {
    return unavailableResult();
  }
}

export function cancelAiServiceRequest(requestId) {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer || !requestId) return false;
  try {
    ipcRenderer.send('ai:service:cancelRequest', { requestId });
    return true;
  } catch (e) {
    return false;
  }
}

export function createDefaultAiServiceConfig(provider) {
  return createAiProviderPresetConfig(provider || 'deepseek');
}
