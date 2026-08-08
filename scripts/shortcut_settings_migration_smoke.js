const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-shortcut-migration-')
);

async function main() {
  try {
    const outfile = path.join(tempDir, 'shortcut-settings-migration.cjs');
    await esbuild.build({
      entryPoints: [path.join(root, 'src/utils/shortcutSettingsMigration.js')],
      outfile,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const { mergeShortcutSettings } = require(outfile);
    const defaults = [
      { id: 'play', name: 'Play', shortcut: 'Ctrl+P', globalShortcut: 'Alt+P' },
      {
        id: 'next',
        name: 'Next',
        shortcut: 'Ctrl+Right',
        globalShortcut: 'Alt+Right',
      },
      {
        id: 'previous',
        name: 'Previous',
        shortcut: 'Ctrl+Left',
        globalShortcut: 'Alt+Left',
      },
    ];

    const migrated = mergeShortcutSettings(defaults, [
      null,
      'bad-item',
      { id: 'play', shortcut: 'Ctrl+Shift+P', globalShortcut: '' },
      { id: 'play', shortcut: 'Ctrl+P' },
      { id: 'next', shortcut: 42, globalShortcut: 'Alt+Shift+Right' },
      { id: 'removed-shortcut', shortcut: 'Ctrl+X' },
      { id: 12, shortcut: 'Ctrl+X' },
    ]);

    assert.deepStrictEqual(migrated, [
      {
        id: 'play',
        name: 'Play',
        shortcut: 'Ctrl+Shift+P',
        globalShortcut: '',
      },
      {
        id: 'next',
        name: 'Next',
        shortcut: 'Ctrl+Right',
        globalShortcut: 'Alt+Shift+Right',
      },
      {
        id: 'previous',
        name: 'Previous',
        shortcut: 'Ctrl+Left',
        globalShortcut: 'Alt+Left',
      },
    ]);
    assert.strictEqual(
      migrated.some(item => item == null),
      false
    );
    assert.deepStrictEqual(
      mergeShortcutSettings(defaults, migrated),
      migrated,
      'shortcut migration must be idempotent'
    );

    const updateAppSource = fs.readFileSync(
      path.join(root, 'src/utils/updateApp.js'),
      'utf8'
    );
    assert.match(updateAppSource, /mergeShortcutSettings\(/);
    process.stdout.write('shortcut settings migration smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
