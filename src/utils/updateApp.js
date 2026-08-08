import initLocalStorage from '@/store/initLocalStorage.js';
import pkg from '../../package.json';
import { readLocalStorageJsonResult } from '@/utils/safeLocalStorage';
import { mergeShortcutSettings } from '@/utils/shortcutSettingsMigration';

const updateSetting = () => {
  const stored = readLocalStorageJsonResult(
    'settings',
    initLocalStorage.settings,
    'object'
  );
  // Do not overwrite corrupt raw data. Missing values can safely be seeded.
  if (stored.status !== 'ok' && stored.status !== 'missing') return;
  const parsedSettings = stored.value;
  const settings = {
    ...initLocalStorage.settings,
    ...parsedSettings,
  };

  settings.shortcuts = mergeShortcutSettings(
    initLocalStorage.settings.shortcuts,
    parsedSettings.shortcuts
  );

  if (localStorage.getItem('appVersion') === '"0.3.9"') {
    settings.lyricsBackground = true;
  }

  localStorage.setItem('settings', JSON.stringify(settings));
};

const updateData = () => {
  const stored = readLocalStorageJsonResult('data', {}, 'object');
  if (stored.status !== 'ok' && stored.status !== 'missing') return;
  const parsedData = stored.value;
  const data = {
    ...parsedData,
  };
  localStorage.setItem('data', JSON.stringify(data));
};

const updatePlayer = () => {
  const stored = readLocalStorageJsonResult('player', {}, 'object');
  if (stored.status !== 'ok' && stored.status !== 'missing') return;
  let parsedData = stored.value;
  let appVersion = localStorage.getItem('appVersion');
  if (appVersion === `"0.2.5"`) parsedData = {}; // 0.2.6版本重构了player
  const data = {
    ...parsedData,
  };
  localStorage.setItem('player', JSON.stringify(data));
};

const removeOldStuff = () => {
  // remove old indexedDB databases created by localforage
  indexedDB.deleteDatabase('tracks');
};

export default function () {
  updateSetting();
  updateData();
  updatePlayer();
  removeOldStuff();
  localStorage.setItem('appVersion', JSON.stringify(pkg.version));
}
