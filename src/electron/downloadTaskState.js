import path from 'path';

export function isPathInsideDirectory(rootDir, filePath) {
  if (!rootDir || !filePath || typeof filePath !== 'string') return false;
  const root = path.resolve(rootDir);
  const candidate = path.resolve(filePath);
  const relative = path.relative(root, candidate);
  return (
    !!relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function createDownloadTaskRegistry() {
  const tasks = new Map();
  let sequence = 0;

  function reserve(episodeId, values = {}) {
    if (!episodeId || tasks.has(episodeId)) return null;
    const task = Object.assign(
      {
        episodeId,
        token: ++sequence,
        phase: 'connecting',
        canceled: false,
        settled: false,
        connection: { canceled: false, request: null },
      },
      values
    );
    tasks.set(episodeId, task);
    return task;
  }

  function owns(episodeId, task) {
    return !!task && tasks.get(episodeId) === task && !task.settled;
  }

  function finalize(episodeId, task) {
    if (!owns(episodeId, task)) return false;
    task.settled = true;
    task.phase = 'settled';
    tasks.delete(episodeId);
    return true;
  }

  return { tasks, reserve, owns, finalize };
}
