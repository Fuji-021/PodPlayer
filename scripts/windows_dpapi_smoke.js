const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-windows-dpapi-')
);

async function main() {
  try {
    const output = path.join(tempDir, 'windows-dpapi.cjs');
    await esbuild.build({
      entryPoints: [path.join(root, 'src/electron/windowsDpapi.js')],
      outfile: output,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const { createWindowsDpapiProtector } = require(output);
    const protector = createWindowsDpapiProtector({
      platform: process.platform,
    });
    const probe = 'podplayer-windows-dpapi-smoke-v1';
    assert.strictEqual(process.platform, 'win32');
    assert.strictEqual(protector.isAvailable(), true);
    const ciphertext = protector.protect(probe);
    assert.ok(ciphertext);
    assert.ok(!ciphertext.includes(probe));
    assert.strictEqual(protector.unprotect(ciphertext), probe);
    process.stdout.write('windows dpapi smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
