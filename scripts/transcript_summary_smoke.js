const assert = require('assert');
const EventEmitter = require('events');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-transcript-summary-')
);

function loadResponse(onResponse, statusCode, body) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.setEncoding = () => {};
  process.nextTick(() => {
    onResponse(response);
    response.emit('data', body);
    response.emit('end');
  });
}

function createHttps(plan) {
  return {
    request(options, onResponse) {
      const request = new EventEmitter();
      request.write = () => {};
      request.end = () => plan({ options, onResponse, request });
      request.destroy = () => {
        request.destroyed = true;
      };
      return request;
    },
  };
}

function segment(text, start) {
  return {
    kind: 'speech',
    display: text,
    start: start || 0,
    end: (start || 0) + 1,
  };
}

async function buildModules() {
  const output = path.join(tempDir, 'summary.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/podcast/transcriptSummary.js')],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const requestOutput = path.join(tempDir, 'request.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/podcast/openAiCompatible.js')],
    outfile: requestOutput,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  return { summary: require(output), request: require(requestOutput) };
}

async function expectReject(promise, code) {
  try {
    await promise;
    assert.fail('expected rejection: ' + code);
  } catch (error) {
    assert.strictEqual(error.code, code);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check, message) {
  for (let index = 0; index < 40; index += 1) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

async function loadTranscriptStateMachine() {
  const mockDir = path.join(tempDir, 'state-machine-mocks');
  fs.mkdirSync(mockDir, { recursive: true });
  const files = {
    vue: path.join(mockDir, 'vue.js'),
    db: path.join(mockDir, 'db.js'),
    store: path.join(mockDir, 'store.js'),
    downloads: path.join(mockDir, 'downloads.js'),
    aiRefine: path.join(mockDir, 'ai-refine.js'),
    summary: path.join(mockDir, 'summary.js'),
    openAi: path.join(mockDir, 'open-ai.js'),
  };
  fs.writeFileSync(
    files.vue,
    'export default { observable(value) { return value; } };\n'
  );
  fs.writeFileSync(
    files.db,
    `function state() { return global.__transcriptSummaryHarness; }
function table(name) {
  return {
    async get(id) {
      const gate = state().getGates.get(id);
      if (gate) { await gate.promise; state().getGates.delete(id); }
      return state()[name].get(id);
    },
    async put(row) {
      state().putCalls += 1;
      const gate = state().putGates.get(row.id);
      if (gate) { await gate.promise; state().putGates.delete(row.id); }
      state()[name].set(row.id, row);
      return row.id;
    },
    delete(id) { state()[name].delete(id); return Promise.resolve(); },
  };
}
export const db = {
  transcripts: table('transcripts'),
  transcriptAi: table('transcriptAi'),
  transcriptSummaries: table('transcriptSummaries'),
  transaction(...args) { return args[args.length - 1](); },
};\n`
  );
  fs.writeFileSync(
    files.store,
    `const store = {
  get state() { return { settings: global.__transcriptSummaryHarness.settings }; },
  dispatch(type, value) { global.__transcriptSummaryHarness.toasts.push({ type, value }); },
};
export default store;\n`
  );
  fs.writeFileSync(
    files.downloads,
    'export function getDownload() { return Promise.resolve(null); }\n'
  );
  fs.writeFileSync(
    files.aiRefine,
    `export const AI_PROMPT_VERSION = 'refine-test';
export function refineEpisode() { return Promise.resolve({ map: {}, changedIdx: [], stats: {} }); }\n`
  );
  fs.writeFileSync(
    files.summary,
    `export const TRANSCRIPT_SUMMARY_PROMPT_VERSION = 'summary-test-v1';
export function buildSummaryParagraphs(segments) {
  return (segments || []).map(item => String((item && item.display) || '')).filter(Boolean);
}
export function hashTranscriptSummarySource(paragraphs) { return JSON.stringify(paragraphs || []); }
export function generateTranscriptSummary(options) {
  const state = global.__transcriptSummaryHarness;
  state.generateCalls += 1;
  return state.generate(options);
}\n`
  );
  fs.writeFileSync(
    files.openAi,
    "export function hasOpenAiKey(cfg) { return !!String((cfg && cfg.key) || '').trim(); }\n"
  );
  const output = path.join(tempDir, 'transcripts-state-machine.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/podcast/transcripts.js')],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'transcript-summary-state-mocks',
        setup(build) {
          const exact = {
            vue: files.vue,
            '@/utils/db': files.db,
            '@/store': files.store,
            '@/utils/podcast/downloads': files.downloads,
            '@/utils/podcast/aiRefine': files.aiRefine,
            '@/utils/podcast/transcriptSummary': files.summary,
            '@/utils/podcast/openAiCompatible': files.openAi,
          };
          Object.keys(exact).forEach(filter => {
            build.onResolve(
              {
                filter: new RegExp(
                  '^' + filter.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '$'
                ),
              },
              () => ({ path: exact[filter] })
            );
          });
        },
      },
    ],
  });
  return require(output);
}

async function testTranscriptStateMachine(summary) {
  const harness = {
    settings: {
      deepseekKey: '',
      deepseekModel: 'mock-model',
      deepseekEndpoint: 'https://mock.invalid',
    },
    transcriptSummaries: new Map(),
    transcriptAi: new Map(),
    transcripts: new Map(),
    getGates: new Map(),
    putGates: new Map(),
    putCalls: 0,
    generateCalls: 0,
    toasts: [],
    generate: null,
  };
  global.__transcriptSummaryHarness = harness;
  global.window = { require: null };
  const transcripts = await loadTranscriptStateMachine();
  const segments = [segment('可总结的文字稿。', 0)];

  const noKey = await transcripts.startTranscriptSummary(
    'no-key',
    'podcast',
    segments
  );
  assert.deepStrictEqual(noKey, { ok: false, reason: 'no-key' });
  assert.strictEqual(
    harness.generateCalls,
    0,
    'no key must never start network work'
  );

  harness.settings.deepseekKey = 'configured-for-smoke';
  const cached = {
    id: 'cached',
    podcastId: 'podcast',
    summary: '已有总结',
    sourceHash: JSON.stringify(['可总结的文字稿。']),
    promptVersion: 'summary-test-v1',
  };
  harness.transcriptSummaries.set('cached', cached);
  const cachedResult = await transcripts.startTranscriptSummary(
    'cached',
    'podcast',
    segments
  );
  assert.strictEqual(cachedResult.cached, true);
  assert.strictEqual(
    harness.generateCalls,
    0,
    'valid cache must not re-request'
  );

  const startLookup = deferred();
  harness.getGates.set('cancel-before-job', startLookup);
  const cancelBeforeJob = transcripts.startTranscriptSummary(
    'cancel-before-job',
    'podcast',
    segments
  );
  transcripts.cancelTranscriptSummary('cancel-before-job');
  startLookup.resolve();
  const canceledBeforeJob = await cancelBeforeJob;
  assert.strictEqual(canceledBeforeJob.canceled, true);
  assert.strictEqual(
    harness.generateCalls,
    0,
    'cancel during cache lookup must not enter network generation'
  );

  const sameEpisode = deferred();
  harness.generate = () => sameEpisode.promise;
  const first = transcripts.startTranscriptSummary(
    'dedupe',
    'podcast',
    segments
  );
  const second = transcripts.startTranscriptSummary(
    'dedupe',
    'podcast',
    segments
  );
  await waitFor(
    () => harness.generateCalls === 1,
    'same-episode request should use one generation job'
  );
  sameEpisode.resolve({
    summary: '并发去重总结',
    sourceHash: JSON.stringify(['可总结的文字稿。']),
    promptVersion: 'summary-test-v1',
    provider: 'mock',
    model: 'mock-model',
    usage: {},
    chunkCount: 1,
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult.ok, true);
  assert.strictEqual(secondResult.ok, true);
  assert.strictEqual(harness.putCalls, 1, 'same episode writes one cached row');

  const canceled = deferred();
  harness.generate = () => canceled.promise;
  const cancelPromise = transcripts.startTranscriptSummary(
    'canceled',
    'podcast',
    segments
  );
  await waitFor(
    () => harness.generateCalls === 2,
    'cancel test should start one controlled request'
  );
  transcripts.cancelTranscriptSummary('canceled');
  canceled.resolve({
    summary: 'must not persist',
    sourceHash: JSON.stringify(['可总结的文字稿。']),
    promptVersion: 'summary-test-v1',
    provider: 'mock',
    model: 'mock-model',
    usage: {},
    chunkCount: 1,
  });
  const canceledResult = await cancelPromise;
  assert.strictEqual(canceledResult.canceled, true);
  assert.strictEqual(harness.transcriptSummaries.has('canceled'), false);

  const previous = {
    id: 'late-cancel',
    podcastId: 'podcast',
    summary: '旧总结',
    sourceHash: 'stale-source',
    promptVersion: 'summary-test-v1',
  };
  harness.transcriptSummaries.set('late-cancel', previous);
  const latePut = deferred();
  harness.putGates.set('late-cancel', latePut);
  harness.generate = async () => ({
    summary: '迟到的新总结',
    sourceHash: JSON.stringify(['可总结的文字稿。']),
    promptVersion: 'summary-test-v1',
    provider: 'mock',
    model: 'mock-model',
    usage: {},
    chunkCount: 1,
  });
  const lateCancel = transcripts.startTranscriptSummary(
    'late-cancel',
    'podcast',
    segments,
    { force: true }
  );
  await waitFor(
    () => harness.putCalls >= 2,
    'late cancellation test should be waiting on the summary write'
  );
  transcripts.cancelTranscriptSummary('late-cancel');
  latePut.resolve();
  const lateCanceledResult = await lateCancel;
  assert.strictEqual(lateCanceledResult.canceled, true);
  assert.strictEqual(
    harness.transcriptSummaries.get('late-cancel').summary,
    '旧总结',
    'late cancellation must restore the prior summary row'
  );

  assert.strictEqual(
    summary.shouldApplyTranscriptSummaryResult('episode-a', 'episode-b'),
    false,
    'stale route results must not update the active panel'
  );
  assert.strictEqual(
    summary.shouldApplyTranscriptSummaryResult('episode-a', 'episode-a'),
    true
  );
  assert.strictEqual(
    summary.isTranscriptSummaryStale(
      {
        summary: 'old',
        sourceHash: summary.hashTranscriptSummarySource(['旧内容。']),
        promptVersion: summary.TRANSCRIPT_SUMMARY_PROMPT_VERSION,
      },
      segments
    ),
    true,
    'source hash changes must make an existing summary stale'
  );
  assert.strictEqual(
    summary.isTranscriptSummaryStale(
      {
        summary: 'current',
        sourceHash: summary.hashTranscriptSummarySource(['可总结的文字稿。']),
        promptVersion: summary.TRANSCRIPT_SUMMARY_PROMPT_VERSION,
      },
      segments
    ),
    false,
    'matching source hash and prompt version should remain reusable'
  );
  delete global.__transcriptSummaryHarness;
  delete global.window;
}

async function main() {
  try {
    const { summary, request } = await buildModules();
    await testTranscriptStateMachine(summary);
    const cfg = {
      key: 'mock-key-only',
      model: 'mock-model',
      endpoint: 'https://api.deepseek.com',
    };
    assert.strictEqual(request.hasOpenAiKey({ key: '' }), false);
    assert.strictEqual(request.hasOpenAiKey({ key: ' configured ' }), true);
    let noKeyRequests = 0;
    await expectReject(
      request.requestOpenAiJson({ ...cfg, key: '' }, [], {
        https: createHttps(() => {
          noKeyRequests += 1;
        }),
      }),
      'no-key'
    );
    assert.strictEqual(noKeyRequests, 0, 'missing key must not open a request');

    assert.strictEqual(
      request.resolveOpenAiChatUrl('https://api.example.test/v1').pathname,
      '/v1/chat/completions'
    );
    await expectReject(
      request.requestOpenAiJson({ ...cfg, endpoint: 'not a url' }, [], {
        https: createHttps(() => {}),
      }),
      'invalid-endpoint'
    );

    const validHttps = createHttps(({ onResponse }) => {
      loadResponse(
        onResponse,
        200,
        JSON.stringify({
          choices: [{ message: { content: '{"summary":"有效总结"}' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        })
      );
    });
    const valid = await request.requestOpenAiJson(cfg, [], {
      https: validHttps,
    });
    assert.strictEqual(valid.data.summary, '有效总结');
    assert.strictEqual(valid.provider, 'api.deepseek.com');

    const invalidHttps = createHttps(({ onResponse }) => {
      loadResponse(
        onResponse,
        200,
        JSON.stringify({ choices: [{ message: { content: '{bad-json' } }] })
      );
    });
    await expectReject(
      request.requestOpenAiJson(cfg, [], { https: invalidHttps }),
      'invalid-json'
    );

    await expectReject(
      request.requestOpenAiJson(cfg, [], {
        https: createHttps(() => {}),
        timeoutMs: 5,
      }),
      'timeout'
    );

    const controller = new AbortController();
    const canceled = request.requestOpenAiJson(cfg, [], {
      https: createHttps(() => {}),
      signal: controller.signal,
    });
    controller.abort();
    await expectReject(canceled, 'canceled');

    const paragraphs = summary.buildSummaryParagraphs([
      segment('第一段。', 0),
      segment('第二段。', 2),
    ]);
    assert.deepStrictEqual(paragraphs, ['第一段。', '第二段。']);
    assert.notStrictEqual(
      summary.hashTranscriptSummarySource(paragraphs),
      summary.hashTranscriptSummarySource(['第一段已修改。', '第二段。'])
    );
    const sentenceChunks = summary.chunkSummaryParagraphs(
      ['甲'.repeat(600) + '。' + '乙'.repeat(600) + '。'],
      1000
    );
    assert.strictEqual(
      sentenceChunks.length,
      2,
      'an overlong paragraph should split at sentence boundaries'
    );

    const longSegments = [
      segment('甲'.repeat(700) + '。', 0),
      segment('乙'.repeat(700) + '。', 2),
      segment('丙'.repeat(700) + '。', 4),
    ];
    const calls = [];
    const generated = await summary.generateTranscriptSummary({
      cfg,
      segments: longSegments,
      maxChunkChars: 1000,
      requestJson: async (_config, messages) => {
        calls.push(messages);
        return {
          data: {
            summary:
              calls.length === 4 ? '最终完整总结' : '临时摘要' + calls.length,
          },
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          provider: 'mock.provider',
          model: 'mock-model',
        };
      },
    });
    assert.strictEqual(
      calls.length,
      4,
      'three paragraph chunks plus one final aggregate'
    );
    assert.strictEqual(generated.summary, '最终完整总结');
    assert.strictEqual(generated.chunkCount, 3);
    assert.strictEqual(generated.usage.total_tokens, 8);

    let canceledBeforeResponse = false;
    await expectReject(
      summary.generateTranscriptSummary({
        cfg,
        segments: [segment('会被取消。', 0)],
        isCanceled: () => canceledBeforeResponse,
        requestJson: async () => {
          canceledBeforeResponse = true;
          return { data: { summary: '陈旧结果' }, usage: {} };
        },
      }),
      'canceled'
    );

    const panelSource = fs.readFileSync(
      path.join(root, 'src/components/TranscriptPanel.vue'),
      'utf8'
    );
    assert.ok(panelSource.includes('async onGenerateSummary()'));
    assert.ok(
      !/mounted\(\)[\s\S]{0,500}startTranscriptSummary/.test(panelSource)
    );
    assert.ok(panelSource.includes('v-if="shouldRenderPanel"'));
    assert.ok(/>\s*总结\s*<\/button>/.test(panelSource));
    assert.ok(panelSource.includes('v-show="contentView === \'transcript\'"'));
    assert.ok(panelSource.includes('restoreTranscriptList()'));
    assert.ok(
      /setContentView\(view\)[\s\S]{0,400}this\.restoreTranscriptList\(\)/.test(
        panelSource
      ),
      'switching back to the transcript must restore its virtual list window'
    );
    assert.ok(
      /\.t-summary\s*\{[\s\S]{0,220}width:\s*100%;[\s\S]{0,220}max-width:\s*760px/.test(
        panelSource
      ),
      'the summary reading surface must be bounded to the text column'
    );
    assert.ok(!panelSource.includes('t-top-link'));
    assert.ok(panelSource.includes('shouldApplyTranscriptSummaryResult'));
    const dbSource = fs.readFileSync(
      path.join(root, 'src/utils/db.js'),
      'utf8'
    );
    const backupSource = fs.readFileSync(
      path.join(root, 'src/utils/podcast/backup.js'),
      'utf8'
    );
    assert.ok(dbSource.includes('db.version(16)'));
    assert.ok(dbSource.includes('transcriptSummaries'));
    assert.ok(backupSource.includes("arr('transcriptSummaries')"));
    assert.ok(backupSource.includes('db.transcriptSummaries'));
    const detailSource = fs.readFileSync(
      path.join(root, 'src/views/episodeDetail.vue'),
      'utf8'
    );
    assert.ok(
      detailSource.indexOf('<TranscriptPanel') <
        detailSource.indexOf('ref="notes"'),
      'the transcript section must precede shownotes'
    );
    assert.ok(
      detailSource.includes('文字稿、精修稿和总结都会保留'),
      'download deletion copy must not imply transcript data is removed'
    );
    const settingsSource = fs.readFileSync(
      path.join(root, 'src/views/settings.vue'),
      'utf8'
    );
    assert.ok(settingsSource.includes('联网 AI 服务'));
    assert.ok(
      settingsSource.includes(
        '只有在你主动生成总结或精修稿时，才会将本集文字稿发送至已配置的'
      )
    );
    const refineSource = fs.readFileSync(
      path.join(root, 'src/utils/podcast/aiRefine.js'),
      'utf8'
    );
    assert.ok(refineSource.includes('requestOpenAiChat(cfg'));
    assert.ok(!refineSource.includes('function chatCompletion('));

    process.stdout.write('transcript summary smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
