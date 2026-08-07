const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const globalSource = fs.readFileSync(
  path.join(root, 'src', 'assets', 'css', 'global.scss'),
  'utf8'
);
const panelSource = fs.readFileSync(
  path.join(root, 'src', 'components', 'TranscriptPanel.vue'),
  'utf8'
);

const tokenNames = [
  'color-transcript-active-bg',
  'color-transcript-active-text',
  'color-transcript-active-accent',
  'color-transcript-active-time',
];

function getThemeBlock(source, selector) {
  const start = source.indexOf(selector);
  assert(start >= 0, `missing theme block: ${selector}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unterminated theme block: ${selector}`);
}

function readToken(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert(match, `missing --${name}`);
  return match[1].trim();
}

function parseColor(value) {
  const hex = value.match(/^#([\da-f]{6})$/i);
  if (hex) {
    const number = parseInt(hex[1], 16);
    return {
      r: (number >> 16) & 255,
      g: (number >> 8) & 255,
      b: number & 255,
      a: 1,
    };
  }
  const rgba = value.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i
  );
  assert(rgba, `unsupported color value: ${value}`);
  return {
    r: Number(rgba[1]),
    g: Number(rgba[2]),
    b: Number(rgba[3]),
    a: rgba[4] === undefined ? 1 : Number(rgba[4]),
  };
}

function composite(foreground, background) {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  return {
    r:
      (foreground.r * foreground.a +
        background.r * background.a * (1 - foreground.a)) /
      alpha,
    g:
      (foreground.g * foreground.a +
        background.g * background.a * (1 - foreground.a)) /
      alpha,
    b:
      (foreground.b * foreground.a +
        background.b * background.a * (1 - foreground.a)) /
      alpha,
    a: alpha,
  };
}

function channelToLinear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(color) {
  return (
    0.2126 * channelToLinear(color.r) +
    0.7152 * channelToLinear(color.g) +
    0.0722 * channelToLinear(color.b)
  );
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort(
    (left, right) => right - left
  );
  return (light + 0.05) / (dark + 0.05);
}

const lightBlock = getThemeBlock(globalSource, ':root');
const darkBlock = getThemeBlock(globalSource, "[data-theme='dark']");

for (const [name, block] of [
  ['light', lightBlock],
  ['dark', darkBlock],
]) {
  for (const token of tokenNames) readToken(block, token);
  const body = parseColor(readToken(block, 'color-body-bg'));
  const list = composite(
    parseColor(readToken(block, 'color-secondary-bg-for-transparent')),
    body
  );
  const activeBackground = composite(
    parseColor(readToken(block, 'color-transcript-active-bg')),
    list
  );
  const textContrast = contrast(
    parseColor(readToken(block, 'color-transcript-active-text')),
    activeBackground
  );
  const timeContrast = contrast(
    parseColor(readToken(block, 'color-transcript-active-time')),
    activeBackground
  );
  assert(
    textContrast >= 4.5,
    `${name} active transcript text contrast must be >= 4.5:1, got ${textContrast.toFixed(
      2
    )}:1`
  );
  assert(
    timeContrast >= 4.5,
    `${name} active transcript time contrast must be >= 4.5:1, got ${timeContrast.toFixed(
      2
    )}:1`
  );
  process.stdout.write(
    `${name}: text ${textContrast.toFixed(2)}:1, time ${timeContrast.toFixed(
      2
    )}:1\n`
  );
}

assert(
  /&\.active,\s*&\.active:hover\s*\{[\s\S]*?background:\s*var\(--color-transcript-active-bg\);[\s\S]*?box-shadow:\s*inset 3px 0 0 var\(--color-transcript-active-accent\);/.test(
    panelSource
  ),
  'active row and active-row hover must preserve the transcript active hierarchy'
);
assert(
  /\.seg-time\s*\{[\s\S]*?color:\s*var\(--color-transcript-active-time\);[\s\S]*?opacity:\s*1;/.test(
    panelSource
  ),
  'active row timestamp must use the dedicated readable transcript token'
);
assert(
  /\.seg-sent\s*\{[\s\S]*?&\.active\s*\{\s*color:\s*var\(--color-transcript-active-text\);\s*\}/.test(
    panelSource
  ),
  'active sentence must not reuse the global primary color'
);
assert(
  !/\.seg-sent\s*\{[\s\S]*?&\.active\s*\{[\s\S]*?text-shadow:/.test(
    panelSource
  ),
  'active sentence must not retain the no-op text shadow'
);
const activeStyle = panelSource.match(
  /\.seg-row\s*\{[\s\S]*?\.seg-spacer\s*\{/
);
assert(activeStyle, 'transcript row style block must remain present');
assert(
  !/!important/.test(activeStyle[0]),
  'active row styles must not use !important'
);
assert(
  !/color-primary-bg-for-transparent/.test(activeStyle[0]),
  'active row must not use the generic transparent primary background token'
);
assert(
  !/user-select|pointer-events/.test(activeStyle[0]),
  'active row styles must not alter selection or seek input semantics'
);
assert(
  /class="seg-row"[\s\S]*?:class="\{ active: rowHasActive\(w\.row\) \}"/.test(
    panelSource
  ),
  'virtual transcript row DOM contract must remain unchanged'
);
assert(
  /padding:\s*8px 12px;/.test(activeStyle[0]) &&
    /line-height:\s*1\.6;/.test(panelSource),
  'readability patch must not change transcript row layout metrics'
);

process.stdout.write('transcript readability smoke: PASS\n');
