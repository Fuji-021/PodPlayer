const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-episode-detail-load-')
);

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function buildGuard() {
  const outfile = path.join(tempDir, 'episode-detail-load-guard.cjs');
  await esbuild.build({
    entryPoints: [
      path.join(root, 'src/utils/podcast/episodeDetailLoadGuard.js'),
    ],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  return require(outfile);
}

async function main() {
  try {
    const { createEpisodeDetailLoadGuard } = await buildGuard();
    const guard = createEpisodeDetailLoadGuard();
    const state = { episodeId: 'A', feedUrl: 'feed-A', episode: null, redirect: 0 };
    const episodeA = deferred();
    const episodeB = deferred();

    async function load(episodePromise, id, feedUrl) {
      state.episodeId = id;
      state.feedUrl = feedUrl;
      const request = guard.begin({ episodeId: id, feedUrl });
      const episode = await episodePromise;
      if (
        !guard.isCurrent(request, {
          episodeId: state.episodeId,
          feedUrl: state.feedUrl,
        })
      ) {
        return 'stale';
      }
      if (!episode) {
        state.redirect++;
        return 'missing';
      }
      state.episode = episode;
      return 'applied';
    }

    const loadA = load(episodeA.promise, 'A', 'feed-A');
    const loadB = load(episodeB.promise, 'B', 'feed-B');
    episodeA.resolve({ id: 'A', title: 'old' });
    assert.strictEqual(await loadA, 'stale');
    assert.strictEqual(state.episode, null);
    episodeB.resolve({ id: 'B', title: 'new' });
    assert.strictEqual(await loadB, 'applied');
    assert.strictEqual(state.episode.id, 'B');

    // A late missing result is also stale: it must not redirect a newer route.
    const lateMissing = deferred();
    const newer = deferred();
    const missingLoad = load(lateMissing.promise, 'missing', 'feed-missing');
    const newerLoad = load(newer.promise, 'newer', 'feed-newer');
    lateMissing.resolve(null);
    assert.strictEqual(await missingLoad, 'stale');
    assert.strictEqual(state.redirect, 0);
    newer.resolve({ id: 'newer' });
    assert.strictEqual(await newerLoad, 'applied');

    // Deactivation invalidates pending work so its late response cannot update
    // a cached detail page after navigation away.
    const inactive = deferred();
    const inactiveLoad = load(inactive.promise, 'inactive', 'feed-inactive');
    guard.invalidate();
    inactive.resolve({ id: 'inactive' });
    assert.strictEqual(await inactiveLoad, 'stale');
    assert.notStrictEqual(state.episode && state.episode.id, 'inactive');

    const component = fs.readFileSync(
      path.join(root, 'src/views/episodeDetail.vue'),
      'utf8'
    );
    assert.match(component, /this\._loadGuard \|\|/);
    assert.match(component, /this\._loadGuard = createEpisodeDetailLoadGuard\(\)/);
    assert.match(component, /if \(this\._loadGuard\) this\._loadGuard\.invalidate/);
    assert.match(component, /const request = guard\.begin/);
    assert.match(component, /if \(!isCurrent\(\)\) return;/);
    assert.match(component, /enrichShownotesIfNeeded\(ep, isCurrent\)/);

    process.stdout.write('episode detail load guard smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
