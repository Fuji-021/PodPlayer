const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-transcript-entry-smoke-')
);

async function main() {
  try {
    const output = path.join(tempDir, 'policy.cjs');
    await esbuild.build({
      entryPoints: [
        path.join(root, 'src/utils/podcast/transcriptEntryPolicy.js'),
      ],
      outfile: output,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const policy = require(output);

    assert.deepStrictEqual(
      policy.getTranscriptEntryBehavior({
        initializing: false,
        platformSupported: false,
        modelReady: false,
        mode: 'no-model',
        hasLocalFile: false,
      }),
      { reason: 'unsupported', action: 'focus', shouldScroll: true }
    );
    assert.deepStrictEqual(
      policy.getTranscriptEntryBehavior({
        initializing: false,
        platformSupported: true,
        modelReady: true,
        mode: 'idle',
        hasLocalFile: false,
      }),
      { reason: 'needs-download', action: 'focus', shouldScroll: false }
    );
    assert.strictEqual(
      policy.getQueuedStateFromAsrStatus({ ok: true, isThisQueued: true }),
      true
    );
    assert.strictEqual(
      policy.getQueuedStateFromAsrStatus({ ok: true, isThisQueued: false }),
      false
    );
    assert.strictEqual(
      policy.getQueuedStateFromAsrStatus({ ok: false, isThisQueued: false }),
      null
    );
    assert.strictEqual(policy.getQueuedStateFromAsrStatus(null), null);

    process.stdout.write('transcript entry policy smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
