const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'podplayer-rendering-'));

async function loadMetadata() {
  const outfile = path.join(tempDir, 'presentation-metadata.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/presentationMetadata.js')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  return require(outfile);
}

async function main() {
  const metadata = await loadMetadata();
  const payload = '<img src=x onerror="window.pwned=1"><script>bad()</script>';
  const copywriter = metadata.getCoverRowSubText({ copywriter: payload }, 'copywriter');
  assert.deepStrictEqual(copywriter, { text: payload, to: '' });

  const artist = metadata.getCoverRowSubText(
    { artist: { id: 42, name: payload } },
    'artist'
  );
  assert.deepStrictEqual(artist, { text: payload, to: '/artist/42' });

  const mv = metadata.getMvSubtitle(
    { artistId: 7, artistName: payload },
    'artist'
  );
  assert.deepStrictEqual(mv, { text: payload, to: '/artist/7' });

  ['src/components/CoverRow.vue', 'src/components/MvRow.vue'].forEach(file => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!source.includes('v-html'), file + ' must not render remote HTML');
    assert.ok(source.includes('router-link'), file + ' must render structured links');
  });

  console.log('untrusted HTML rendering smoke passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
