export function getTranscriptEntryBehavior(state) {
  if (state.initializing) {
    return { reason: 'loading', action: 'focus', shouldScroll: false };
  }
  if (!state.platformSupported) {
    // 无文字稿时不再渲染空面板，详情入口以明确降级提示完成交互。
    return { reason: 'unsupported', action: 'focus', shouldScroll: false };
  }
  if (!state.modelReady) {
    return { reason: 'no-model', action: 'settings', shouldScroll: false };
  }
  if (state.mode === 'idle') {
    // Permanent audio is preferred when available. Otherwise the source layer
    // prepares a task-scoped temporary file; an entry click never starts the
    // user-visible download workflow.
    return { reason: 'generate', action: 'generate', shouldScroll: false };
  }
  return { reason: 'available', action: 'focus', shouldScroll: true };
}

export function getQueuedStateFromAsrStatus(status) {
  if (!status || status.ok !== true) return null;
  return !!status.isThisQueued;
}
