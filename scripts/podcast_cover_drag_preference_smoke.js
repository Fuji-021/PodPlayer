const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-cover-drag-')
);

function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function makeDragEvent() {
  return {
    prevented: 0,
    preventDefault() {
      this.prevented += 1;
    },
  };
}

async function main() {
  try {
    const output = path.join(tempDir, 'cover-drag-preference.cjs');
    await esbuild.build({
      entryPoints: [
        path.join(root, 'src/utils/podcast/coverDragPreference.js'),
      ],
      outfile: output,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const preference = require(output);

    assert.strictEqual(
      preference.isPodcastCoverDragEnabled(),
      true,
      'legacy settings without the new key keep podcast-cover dragging enabled'
    );
    assert.strictEqual(
      preference.isPodcastCoverDragEnabled({}),
      true,
      'an absent preference defaults to enabled'
    );
    assert.strictEqual(
      preference.isPodcastCoverDragEnabled({ allowPodcastCoverDrag: false }),
      false,
      'an explicit false disables only podcast-cover dragging'
    );

    const disabledEvent = makeDragEvent();
    assert.strictEqual(
      preference.guardPodcastCoverDrag(disabledEvent, {
        allowPodcastCoverDrag: false,
      }),
      false,
      'the disabled preference rejects the native drag at the cover boundary'
    );
    assert.strictEqual(
      disabledEvent.prevented,
      1,
      'the disabled preference prevents exactly the current native drag event'
    );

    const enabledEvent = makeDragEvent();
    assert.strictEqual(
      preference.guardPodcastCoverDrag(enabledEvent, {
        allowPodcastCoverDrag: true,
      }),
      true,
      'an enabled preference leaves native dragging intact'
    );
    assert.strictEqual(
      enabledEvent.prevented,
      0,
      'an enabled preference does not interfere with the browser drag path'
    );

    const podImage = readSource('src/components/PodImage.vue');
    assert(
      podImage.includes('podcastCover: { type: Boolean, default: false }'),
      'PodImage keeps non-podcast images opt-in to the drag preference'
    );
    assert(
      podImage.includes(':draggable="coverDragEnabled"') &&
        podImage.includes('@dragstart="onDragStart"'),
      'PodImage changes only its native image drag behavior at the component boundary'
    );

    const episodeCover = readSource(
      'src/components/podcast/SubscriptionEpisodeCover.vue'
    );
    assert.strictEqual(
      (episodeCover.match(/:draggable="coverDragEnabled"/g) || []).length,
      2,
      'the update feed base and episode cover layers both honor the preference'
    );
    assert.strictEqual(
      (episodeCover.match(/@dragstart="onDragStart"/g) || []).length,
      2,
      'both update-feed cover layers guard native dragging independently'
    );

    const podcastCoverEntryPoints = [
      'src/components/DiscoverCard.vue',
      'src/components/Player.vue',
      'src/components/podcast/SubscriptionProgramRail.vue',
      'src/views/downloadsList.vue',
      'src/views/episodeDetail.vue',
      'src/views/favoritesList.vue',
      'src/views/historyList.vue',
      'src/views/podcastDetail.vue',
      'src/views/podcastLibrary.vue',
      'src/views/searchPodcast.vue',
      'src/views/statsPage.vue',
    ];
    podcastCoverEntryPoints.forEach(relativePath => {
      const source = readSource(relativePath);
      assert(
        source.includes('podcast-cover') ||
          source.includes('allowPodcastCoverDrag') ||
          source.includes('coverDragEnabled'),
        relativePath + ' marks or guards its podcast-cover entry point'
      );
    });

    const player = readSource('src/components/Player.vue');
    assert(
      player.includes('class="qp-handle"') &&
        player.includes('draggable="true"') &&
        player.includes('onQueueDragStart'),
      'the queue reorder handle remains its own native drag mechanism'
    );

    const defaults = readSource('src/store/initLocalStorage.js');
    assert(
      defaults.includes('allowPodcastCoverDrag: true'),
      'new profiles retain the existing default of allowing cover drag-out'
    );

    const settingsView = readSource('src/views/settings.vue');
    assert(
      settingsView.includes('v-model="allowPodcastCoverDrag"') &&
        settingsView.includes('key: \'allowPodcastCoverDrag\''),
      'the Settings toggle persists the preference through the existing settings path'
    );
    assert(
      settingsView.includes("toggleSettingsInfo('nas-connection')") &&
        settingsView.includes('aria-controls="nas-connection-info"'),
      'NAS help reuses the accessible settings popover with a stable control relationship'
    );
    [
      'src/locale/lang/zh-CN.js',
      'src/locale/lang/zh-TW.js',
      'src/locale/lang/en.js',
      'src/locale/lang/tr.js',
    ].forEach(relativePath => {
      const locale = readSource(relativePath);
      assert(
        locale.includes('allowPodcastCoverDrag:') &&
          locale.includes('allowPodcastCoverDragDesc:') &&
          locale.includes('nasHelpDescription:'),
        relativePath + ' supplies all new settings labels'
      );
    });

    const mutationOutput = path.join(tempDir, 'mutations.cjs');
    await esbuild.build({
      entryPoints: [path.join(root, 'src/store/mutations.js')],
      outfile: mutationOutput,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const mutations = require(mutationOutput).default;
    const legacySettings = { nyancatStyle: false };
    const legacyState = { settings: legacySettings };
    mutations.updateSettings(legacyState, {
      key: 'allowPodcastCoverDrag',
      value: false,
    });
    assert.notStrictEqual(
      legacyState.settings,
      legacySettings,
      'adding the preference to a legacy Vue 2 settings payload replaces the object reactively'
    );
    assert.strictEqual(
      legacyState.settings.allowPodcastCoverDrag,
      false,
      'the reactive legacy migration preserves the explicit disabled value'
    );
    assert.strictEqual(
      legacyState.settings.nyancatStyle,
      false,
      'the reactive replacement preserves unrelated settings'
    );

    console.log('podcast cover drag preference smoke passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
