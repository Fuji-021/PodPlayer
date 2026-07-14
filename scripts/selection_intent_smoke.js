const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-selection-smoke-')
);

function element(parent, selection) {
  return {
    nodeType: 1,
    parentElement: parent || null,
    parentNode: parent || null,
    dataset: selection ? { selection } : {},
    closest(selector) {
      if (selector !== '[data-selection="content"]') return null;
      if (this.dataset.selection === 'content') return this;
      return this.parentElement && this.parentElement.closest
        ? this.parentElement.closest(selector)
        : null;
    },
    contains(node) {
      let current = node;
      while (current) {
        if (current === this) return true;
        current = current.parentElement || current.parentNode || null;
      }
      return false;
    },
  };
}

function selectionFor(range) {
  return {
    rangeCount: range ? 1 : 0,
    isCollapsed: !range,
    getRangeAt() {
      return range;
    },
  };
}

async function main() {
  try {
    const output = path.join(tempDir, 'selection-intent.cjs');
    await esbuild.build({
      entryPoints: [path.join(root, 'src/utils/selectionIntent.js')],
      outfile: output,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const intent = require(output);

    const row = element();
    const content = element(row, 'content');
    const ui = element(row, 'ui');
    const outside = element();
    const selectedText = { parentElement: content, parentNode: content };
    const outsideText = { parentElement: outside, parentNode: outside };

    global.window = {
      getSelection: () =>
        selectionFor({
          startContainer: selectedText,
          endContainer: selectedText,
        }),
    };
    assert.strictEqual(intent.isContentSelectionTarget(selectedText), true);
    assert.strictEqual(intent.isContentSelectionTarget(ui), false);
    assert.strictEqual(intent.hasSelectionWithin(row), true);
    assert.strictEqual(
      intent.shouldPreserveSelection({ target: selectedText }, row),
      true
    );
    assert.strictEqual(
      intent.shouldPreserveSelection({ target: ui }, row),
      false
    );

    global.window.getSelection = () =>
      selectionFor({
        startContainer: outsideText,
        endContainer: outsideText,
      });
    assert.strictEqual(intent.hasSelectionWithin(row), false);
    assert.strictEqual(
      intent.shouldPreserveSelection({ target: selectedText }, row),
      false
    );

    global.window.getSelection = () => ({
      rangeCount: 1,
      isCollapsed: true,
      getRangeAt() {
        return { startContainer: selectedText, endContainer: selectedText };
      },
    });
    assert.strictEqual(intent.hasSelectionWithin(row), false);
    process.stdout.write('selection intent smoke: PASS\n');
  } finally {
    delete global.window;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
