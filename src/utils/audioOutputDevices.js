import store from '@/store';
import { decideOutputDeviceFallback } from '@/utils/powerResumePolicy';

export async function enumerateAudioOutputDevices(mediaDevices) {
  const api =
    mediaDevices ||
    (typeof navigator !== 'undefined' && navigator.mediaDevices);
  if (!api || typeof api.enumerateDevices !== 'function') return [];
  try {
    const devices = await api.enumerateDevices();
    return Array.isArray(devices)
      ? devices.filter(device => device && device.kind === 'audiooutput')
      : [];
  } catch (e) {
    return [];
  }
}

export function installAudioOutputDeviceMonitor(player, options) {
  const opts = options || {};
  const appStore = opts.store || store;
  const mediaDevices =
    opts.mediaDevices ||
    (typeof navigator !== 'undefined' && navigator.mediaDevices);
  if (
    !mediaDevices ||
    typeof mediaDevices.enumerateDevices !== 'function' ||
    typeof mediaDevices.addEventListener !== 'function'
  ) {
    return () => {};
  }

  let disposed = false;
  let timer = null;
  let checking = false;
  let rerun = false;
  const delay = Number(opts.debounceMs) >= 0 ? Number(opts.debounceMs) : 350;

  const check = async () => {
    if (disposed) return;
    if (checking) {
      rerun = true;
      return;
    }
    checking = true;
    try {
      const devices = await enumerateAudioOutputDevices(mediaDevices);
      if (disposed) return;
      const saved = appStore.state.settings.outputDevice || 'default';
      const decision = decideOutputDeviceFallback(saved, devices);
      if (!decision.fallback) return;

      appStore.commit('changeOutputDevice', 'default');
      if (player && typeof player.setOutputDevice === 'function') {
        await player.setOutputDevice('default');
      }
      appStore.dispatch(
        'showToast',
        '音频输出设备已断开，已切换到系统默认设备'
      );
    } finally {
      checking = false;
      if (rerun && !disposed) {
        rerun = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      check().catch(() => {});
    }, delay);
  };

  mediaDevices.addEventListener('devicechange', schedule);
  schedule();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    mediaDevices.removeEventListener('devicechange', schedule);
  };
}
