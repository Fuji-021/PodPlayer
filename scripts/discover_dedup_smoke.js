const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-discover-dedup-smoke-')
);

async function loadDiscover() {
  const serviceStub = path.join(tempDir, 'service-stub.js');
  fs.writeFileSync(
    serviceStub,
    'export const subscribeByRssUrl = async () => ({}); export const previewByRssUrl = async () => ({});\n'
  );
  const output = path.join(tempDir, 'discover.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/podcast/discover.js')],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'service-stub',
        setup(build) {
          build.onResolve({ filter: /^\.\/service$/ }, () => ({
            path: serviceStub,
          }));
        },
      },
    ],
  });
  return require(output);
}

async function main() {
  try {
    const discover = await loadDiscover();

    assert.strictEqual(
      discover.normalizeDiscoverName('Ｐｏｄ（Ｖ１）：Ｈｅｌｌｏ！'),
      'pod(v1):hello!'
    );
    assert.strictEqual(
      discover.normalizeDiscoverName(' Pod ( V1 ) : H e l l o ! '),
      'pod(v1):hello!'
    );
    assert.strictEqual(
      discover.normalizeDiscoverName('“Podcast” — Vol. 2'),
      '"podcast"-vol.2'
    );

    const baseA = { name: 'Ｐｏｄ（Ｖ１）：Ｈｅｌｌｏ！', source: 'xyzrank' };
    const baseB = { name: 'Another Show', source: 'xyzrank' };
    const extraDuplicate = { name: 'pod (v1): hello!', source: 'apple' };
    const extraC = { name: 'Case Study 2', source: 'apple' };
    const extraD = { name: 'Trailing Show', source: 'apple' };
    const merged = discover.mergeDiscoverByName(
      [baseA, baseB],
      [extraDuplicate, extraC, { name: 'ANOTHER SHOW' }, extraD]
    );
    assert.deepStrictEqual(merged, [baseA, baseB, extraC, extraD]);
    assert.strictEqual(merged[0], baseA);
    assert.strictEqual(merged[1], baseB);

    const distinct = discover.mergeDiscoverByName(
      [{ name: '节目！' }, { name: '节目：第一季' }],
      [{ name: '节目?' }, { name: '节目：第二季' }]
    );
    assert.deepStrictEqual(
      distinct.map(item => item.name),
      ['节目！', '节目：第一季', '节目?', '节目：第二季']
    );

    const blankBase = { name: '' };
    const blankMerged = discover.mergeDiscoverByName(
      [blankBase],
      [{ name: '' }, { name: '  ' }]
    );
    assert.deepStrictEqual(blankMerged, [blankBase]);

    process.stdout.write('discover dedup smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
