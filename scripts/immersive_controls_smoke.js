const assert = require('assert');
const fs = require('fs');
const path = require('path');

const playerPath = path.join(
  __dirname,
  '..',
  'src',
  'components',
  'Player.vue'
);
const source = fs.readFileSync(playerPath, 'utf8');
const settingsPath = path.join(__dirname, '..', 'src', 'views', 'settings.vue');
const settingsSource = fs.readFileSync(settingsPath, 'utf8');

function expect(pattern, message) {
  assert(pattern.test(source), message);
}

function expectAbsent(pattern, message) {
  assert(!pattern.test(source), message);
}

expectAbsent(
  /v-tip="currentTrack\.name"\s+class="imm-ep"/,
  'immersive episode title must not register a hover tooltip'
);
expectAbsent(
  /v-tip="podcastName"\s+class="imm-pod"/,
  'immersive podcast title must not register a hover tooltip'
);
expect(
  /class="imm-ep"\s+data-selection="content"\s+@click="immClickTitle\(\$event\)"/,
  'episode title must retain content selection and detail navigation'
);
expect(
  /class="imm-pod"\s+data-selection="content"\s+@click="immClickPodcast\(\$event\)"/,
  'podcast title must retain content selection and detail navigation'
);
expectAbsent(
  /\.imm-ep\s*\{[\s\S]*?&:hover\s*\{[\s\S]*?text-decoration:\s*underline;/,
  'immersive episode title must not add a hover underline'
);
expectAbsent(
  /\.imm-pod\s*\{[\s\S]*?&:hover\s*\{[\s\S]*?text-decoration:\s*underline;/,
  'immersive podcast title must not add a hover underline'
);
const toggleImmTranscript = source.match(
  /toggleImmTranscript\(\) \{([\s\S]*?)\n[ ]{4}\},\n[ ]{4}\/\/ 文稿点句跳播/
);
assert(
  toggleImmTranscript,
  'toggleImmTranscript implementation must remain present'
);
expect(
  /if \(!this\.immTranscriptAvailable\) \{\s*return;\s*\}/,
  'a missing transcript must be a silent no-op in immersive mode'
);
assert(
  !/showToast/.test(toggleImmTranscript[1]),
  'a missing transcript must not show an immersive toast'
);
expect(
  /immTranscriptOpen = !this\.immTranscriptOpen;/,
  'an available transcript must keep its existing cover-toggle behavior'
);
assert(
  settingsSource.includes('生成后可在沉浸页点击封面查看。'),
  'the local transcript settings copy must explain the immersive entry point'
);
expect(
  /class="imm-top"\s+:class="\{ 'is-playing': playing \}"/,
  'close control visibility must derive from the existing playing state'
);
expect(
  /aria-label="关闭沉浸页"/,
  'close control must keep an accessible name without a visible tooltip'
);
expect(
  /width: clamp\(72px, 7vw, 112px\);[\s\S]*?-webkit-app-region: no-drag;/,
  'top-right hover region must be stable and opt out of the window drag region'
);
expect(
  /&\.is-playing:not\(:hover\):not\(:focus-within\) \.imm-collapse[\s\S]*?opacity: 0;[\s\S]*?pointer-events: none;/,
  'playing state must hide a non-hovered, non-focused close button without an invisible click target'
);
expect(
  /@media \(hover: none\)[\s\S]*?opacity: 1;[\s\S]*?pointer-events: auto;/,
  'non-hover devices must retain a visible, tappable close control'
);
expect(
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition: none;/,
  'reduced motion must make the visibility change immediate'
);
expect(
  /\.imm-drag-bar[\s\S]*?-webkit-app-region: drag;/,
  'the native top drag bar must remain present'
);
expect(
  /closeImmersive\(\) \{[\s\S]*?document\.removeEventListener\('keydown', this\._immKeyHandler\)/,
  'closeImmersive must retain ESC listener cleanup'
);
expect(
  /_immKeyDown\(ev\) \{[\s\S]*?this\.closeImmersive\(\);/,
  'ESC close behavior must remain wired to closeImmersive'
);
expectAbsent(
  /immClose(?:Hovered|Visible|Timer|Listener)/,
  'the control must not add reactive hover state, timers, or listeners'
);

process.stdout.write('immersive controls smoke: PASS\n');
