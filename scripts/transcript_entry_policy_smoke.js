const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const transcriptPanelPath = path.join(
  root,
  'src/components/TranscriptPanel.vue'
);
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-transcript-entry-smoke-')
);

async function main() {
  try {
    const transcriptPanelSource = fs.readFileSync(transcriptPanelPath, 'utf8');
    assert(
      transcriptPanelSource.includes('v-tip="transcriptSourceHint"'),
      'idle transcript actions must retain an accessible source hint on hover/focus'
    );
    assert(
      transcriptPanelSource.includes('transcriptSourceHint()'),
      'the source hint must remain derived from the actual local-media state'
    );
    assert(
      !transcriptPanelSource.includes('将临时准备音频，在本地生成文字稿后自动清理'),
      'the idle panel must not retain the persistent transient-source explanation'
    );
    assert(
      !transcriptPanelSource.includes('将复用已下载音频，在本地生成带时间戳的文字稿'),
      'the idle panel must not retain a mismatched persistent-source explanation'
    );
    assert(
      !transcriptPanelSource.includes('class="t-note"'),
      'the removed persistent idle source note must not leave stale markup'
    );

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
      { reason: 'unsupported', action: 'focus', shouldScroll: false }
    );
    assert.deepStrictEqual(
      policy.getTranscriptEntryBehavior({
        initializing: false,
        platformSupported: true,
        modelReady: true,
        mode: 'idle',
        hasLocalFile: false,
      }),
      { reason: 'generate', action: 'generate', shouldScroll: false }
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
