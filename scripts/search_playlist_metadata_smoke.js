const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-playlist-metadata-')
);

async function main() {
  const outfile = path.join(tempDir, 'presentation-metadata.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/presentationMetadata.js')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { getCoverRowSubText } = require(outfile);

  assert.deepStrictEqual(
    getCoverRowSubText(
      {
        creator: { nickname: '\u64ad\u5ba2\u7f16\u8f91\u90e8' },
        trackCount: 42,
      },
      'title'
    ),
    { text: '\u64ad\u5ba2\u7f16\u8f91\u90e8 \u00b7 42 \u9996', to: '' }
  );
  assert.deepStrictEqual(
    getCoverRowSubText(
      { creator: { nickname: '\u64ad\u5ba2\u7f16\u8f91\u90e8' } },
      'title'
    ),
    { text: '\u64ad\u5ba2\u7f16\u8f91\u90e8', to: '' }
  );
  assert.deepStrictEqual(getCoverRowSubText({ trackCount: 8 }, 'title'), {
    text: '8 \u9996',
    to: '',
  });
  assert.deepStrictEqual(getCoverRowSubText({}, 'title'), { text: '', to: '' });
  assert.strictEqual(
    getCoverRowSubText(
      { creator: { nickname: '<img src=x onerror=bad()>' }, trackCount: 1 },
      'title'
    ).text,
    '<img src=x onerror=bad()> \u00b7 1 \u9996'
  );

  const source = fs.readFileSync(
    path.join(root, 'src/components/CoverRow.vue'),
    'utf8'
  );
  assert.ok(
    source.includes('subTextInfo(item).text'),
    'missing playlist metadata must not create an empty info row'
  );
  assert.ok(!source.includes('v-html'));
  console.log('search playlist metadata smoke passed');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
