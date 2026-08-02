export function getSendSettingsPlugin() {
  const electron = window.require('electron');
  const ipcRenderer = electron.ipcRenderer;
  return store => {
    store.subscribe((mutation, state) => {
      // console.log(mutation);
      if (mutation.type !== 'updateSettings') return;
      // Legacy renderer-stored AI keys must never be mirrored into
      // electron-store while safeStorage migration is in progress.
      const settings = Object.assign({}, state.settings || {});
      delete settings.deepseekKey;
      delete settings.deepseekModel;
      delete settings.deepseekEndpoint;
      ipcRenderer.send('settings', settings);
    });
  };
}
