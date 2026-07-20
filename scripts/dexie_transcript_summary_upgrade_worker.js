const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');

const root = process.env.PODPLAYER_DEXIE_SMOKE_ROOT;
const userData = process.env.PODPLAYER_DEXIE_SMOKE_USER_DATA;

if (!root || !userData) {
  throw new Error('Dexie upgrade smoke requires an isolated root and userData');
}

app.disableHardwareAcceleration();
app.setPath('userData', userData);

function runRendererUpgrade(window) {
  const dexiePath = path.join(root, 'node_modules', 'dexie');
  const databaseName = 'podplayer-dexie-upgrade-smoke';
  return window.webContents.executeJavaScript(
    `
      (async () => {
        try {
        const Dexie = require(${JSON.stringify(dexiePath)});
        const assert = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const dbName = ${JSON.stringify(databaseName)};
        await Dexie.delete(dbName);

        const v15 = new Dexie(dbName);
        v15.version(15).stores({
          episodes: '&id, podcastId, pubTime',
          transcriptAi: '&id, podcastId',
        });
        await v15.open();
        await v15.episodes.put({ id: 'episode-v15', podcastId: 'podcast', pubTime: 1 });
        await v15.transcriptAi.put({ id: 'episode-v15', podcastId: 'podcast', segs: {} });
        v15.close();

        const v16 = new Dexie(dbName);
        v16.version(15).stores({
          episodes: '&id, podcastId, pubTime',
          transcriptAi: '&id, podcastId',
        });
        v16.version(16).stores({
          episodes: '&id, podcastId, pubTime',
          transcriptAi: '&id, podcastId',
          transcriptSummaries: '&id, podcastId, sourceHash, updatedAt',
        });
        await v16.open();

        const episode = await v16.episodes.get('episode-v15');
        const ai = await v16.transcriptAi.get('episode-v15');
        assert(episode && episode.podcastId === 'podcast', 'v15 episode data was lost');
        assert(ai && ai.id === 'episode-v15', 'v15 transcriptAi data was lost');

        await v16.transcriptSummaries.put({
          id: 'episode-v15',
          podcastId: 'podcast',
          summary: '升级后的本集总结',
          sourceHash: 'smoke-hash',
          updatedAt: Date.now(),
        });
        const summary = await v16.transcriptSummaries.get('episode-v15');
        assert(summary && summary.summary === '升级后的本集总结', 'v16 summary table is unavailable');
        v16.close();
        await Dexie.delete(dbName);
        return { ok: true, error: '' };
        } catch (error) {
          return {
            ok: false,
            error: String((error && error.message) || error || 'unknown error'),
          };
        }
      })()
    `,
    true
  );
}

function createLocalSmokePage() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>dexie-upgrade-smoke</title>');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/dexie-upgrade-smoke`,
      });
    });
  });
}

app.whenReady().then(async () => {
  let window;
  let localPage;
  try {
    localPage = await createLocalSmokePage();
    window = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    await window.loadURL(localPage.url);
    const result = await runRendererUpgrade(window);
    if (!result || !result.ok) {
      throw new Error(
        'Dexie upgrade smoke did not finish: ' +
          ((result && result.error) || '')
      );
    }
    console.log('dexie transcript summary upgrade worker: PASS');
    app.exit(0);
  } catch (error) {
    console.error(
      'dexie transcript summary upgrade worker: FAIL',
      (error && error.stack) || error
    );
    app.exit(1);
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    if (localPage && localPage.server) localPage.server.close();
  }
});
