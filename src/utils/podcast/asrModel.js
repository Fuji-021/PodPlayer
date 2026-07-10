const ipcRenderer = window.require
  ? window.require('electron').ipcRenderer
  : null;

export async function getModelStatus() {
  if (!ipcRenderer) return { ok: false, ready: false };
  try {
    return await ipcRenderer.invoke('asr:modelStatus');
  } catch (e) {
    return { ok: false, ready: false, error: String((e && e.message) || e) };
  }
}

export async function installModel() {
  if (!ipcRenderer) return { ok: false, error: 'not-electron' };
  try {
    return await ipcRenderer.invoke('asr:modelInstall');
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export async function cancelModelInstall() {
  if (!ipcRenderer) return { ok: false, error: 'not-electron' };
  try {
    return await ipcRenderer.invoke('asr:modelCancelInstall');
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export async function removeModel() {
  if (!ipcRenderer) return { ok: false, error: 'not-electron' };
  try {
    return await ipcRenderer.invoke('asr:modelRemove');
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export async function selectLocalModelDir() {
  if (!ipcRenderer) return { ok: false, error: 'not-electron' };
  try {
    return await ipcRenderer.invoke('asr:modelSelectLocalDir');
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export async function verifyModel() {
  if (!ipcRenderer) return { ok: false, error: 'not-electron' };
  try {
    return await ipcRenderer.invoke('asr:modelVerify');
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export function onModelInstallProgress(handler) {
  if (!ipcRenderer || typeof handler !== 'function') return function () {};
  const wrapped = function (_e, payload) {
    handler(payload || {});
  };
  ipcRenderer.on('asr:modelInstallProgress', wrapped);
  return function () {
    try {
      ipcRenderer.removeListener('asr:modelInstallProgress', wrapped);
    } catch (e) {
      /* ignore */
    }
  };
}
