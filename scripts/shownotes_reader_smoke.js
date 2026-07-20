const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-shownotes-reader-smoke-')
);
const MEDIA_CLASS = 'pp-shownotes-reader-media';
const BLOCK_CLASS = 'pp-shownotes-reader-media--block';
const LINK_CLASS = 'pp-shownotes-reader-media-link';
const FLOW_CLASS = 'pp-shownotes-reader-media-flow';
const FIGURE_CLASS = 'pp-shownotes-reader-media-figure';

function hasClass(node, className) {
  return String(node.getAttribute('class') || '')
    .split(/\s+/)
    .includes(className);
}

function getById(rootNode, id) {
  return Array.prototype.slice
    .call(rootNode.getElementsByTagName('*'))
    .find(node => node.getAttribute('id') === id);
}

function parseRoot(markup) {
  return new DOMParser().parseFromString(
    `<root>${markup}</root>`,
    'application/xml'
  ).documentElement;
}

function assertReaderMedia(node, id) {
  const image = getById(node, id);
  assert.ok(image, `missing ${id}`);
  assert.ok(hasClass(image, MEDIA_CLASS), `${id} is reader media`);
  assert.ok(hasClass(image, BLOCK_CLASS), `${id} is a block`);
}

function assertIdempotent(normalizeShownotesReaderMedia, notes) {
  normalizeShownotesReaderMedia(notes);
  const firstPass = new XMLSerializer().serializeToString(notes);
  normalizeShownotesReaderMedia(notes);
  assert.strictEqual(new XMLSerializer().serializeToString(notes), firstPass);
}

async function loadNormalizer() {
  const output = path.join(tempDir, 'shownotes-reader-media.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/podcast/shownotesReaderMedia.js')],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  return require(output);
}

async function main() {
  try {
    const { normalizeShownotesReaderMedia } = await loadNormalizer();
    const notes = parseRoot(`
      <p id="single-wrap"> <br/> <img id="single" class="publisher-cover" src="https://cdn.example.test/single.jpg" srcset="https://cdn.example.test/single-2x.jpg 2x" alt="Single cover" draggable="true"/> </p>
      <div id="two-wrap">\n<img id="two-a" src="https://cdn.example.test/two-a.jpg"/><br/>\n<img id="two-b" src="https://cdn.example.test/two-b.jpg"/>\n</div>
      <p id="three-wrap"><img id="three-a" src="https://cdn.example.test/three-a.jpg"/><img id="three-b" src="https://cdn.example.test/three-b.jpg"/><img id="three-c" src="https://cdn.example.test/three-c.jpg"/></p>
      <p id="inline">Text before <img id="inline-image" src="https://cdn.example.test/icon.png" alt="icon"/> and text after.</p>
      <div id="linked-wrap"><a id="image-link" class="publisher-link" href="https://example.test/source"><img id="linked-image" src="https://cdn.example.test/linked.jpg" alt="Linked" draggable="true"/></a></div>
      <figure id="one-figure"><img id="figure-one" src="https://cdn.example.test/figure-one.jpg"/><figcaption id="figure-caption">Caption <img id="caption-icon" src="https://cdn.example.test/caption-icon.jpg"/> <a id="timestamp" class="ts-seek" data-sec="65">1:05</a></figcaption></figure>
      <figure id="many-figure"><img id="figure-many-a" src="https://cdn.example.test/figure-many-a.jpg"/><br/><a id="figure-many-link" href="https://example.test/gallery"><img id="figure-many-b" src="https://cdn.example.test/figure-many-b.jpg"/></a><img id="figure-many-c" src="https://cdn.example.test/figure-many-c.jpg"/><figcaption>Gallery caption</figcaption></figure>
      <figure id="nested-figure"><p id="nested-figure-flow"><img id="nested-figure-a" src="https://cdn.example.test/nested-a.jpg"/><img id="nested-figure-b" src="https://cdn.example.test/nested-b.jpg"/></p><figcaption>Nested gallery</figcaption></figure>
      <!-- Deidentified structural fixture from the No.210 reader input: most
           independent images are direct article children; one is a figure. -->
      <img id="no210-root-a" src="https://cdn.example.test/root-a.jpg"/>
      <br/>
      <a id="no210-root-link" href="https://example.test/reference"><span><img id="no210-root-b" src="https://cdn.example.test/root-b.jpg" draggable="true"/></span></a>
      <figure id="no210-root-figure"><img id="no210-root-figure-image" src="https://cdn.example.test/root-figure.jpg"/><figcaption>Figure caption</figcaption></figure>
      <p id="wrapped-root"><span><a id="wrapped-root-link" href="https://example.test/wrapped"><img id="wrapped-root-image" src="https://cdn.example.test/wrapped.jpg"/></a></span></p>
      <p id="no210-inline">正文中的 <img id="no210-inline-image" src="https://cdn.example.test/inline.jpg"/> 小图不应改变排版。</p>
      <p id="bad-wrap"><img id="bad-image" alt="missing source"/></p>
    `);

    assertIdempotent(normalizeShownotesReaderMedia, notes);

    ['single', 'two-a', 'two-b', 'three-a', 'three-b', 'three-c'].forEach(id =>
      assertReaderMedia(notes, id)
    );
    assert.ok(hasClass(getById(notes, 'single-wrap'), FLOW_CLASS));
    assert.ok(hasClass(getById(notes, 'two-wrap'), FLOW_CLASS));
    assert.ok(hasClass(getById(notes, 'three-wrap'), FLOW_CLASS));

    const single = getById(notes, 'single');
    assert.strictEqual(
      single.getAttribute('src'),
      'https://cdn.example.test/single.jpg'
    );
    assert.strictEqual(
      single.getAttribute('srcset'),
      'https://cdn.example.test/single-2x.jpg 2x'
    );
    assert.strictEqual(single.getAttribute('alt'), 'Single cover');
    assert.strictEqual(single.getAttribute('draggable'), 'true');
    assert.strictEqual(single.getAttribute('decoding'), 'async');
    assert.ok(hasClass(single, 'publisher-cover'));

    const inlineImage = getById(notes, 'inline-image');
    assert.ok(!hasClass(inlineImage, MEDIA_CLASS));
    assert.ok(!hasClass(getById(notes, 'inline'), FLOW_CLASS));

    assertReaderMedia(notes, 'linked-image');
    const link = getById(notes, 'image-link');
    assert.ok(hasClass(link, LINK_CLASS));
    assert.ok(hasClass(link, BLOCK_CLASS));
    assert.ok(hasClass(link, 'publisher-link'));
    assert.strictEqual(
      link.getAttribute('href'),
      'https://example.test/source'
    );

    [
      'figure-one',
      'figure-many-a',
      'figure-many-b',
      'figure-many-c',
      'nested-figure-a',
      'nested-figure-b',
    ].forEach(id => assertReaderMedia(notes, id));
    assert.ok(hasClass(getById(notes, 'one-figure'), FIGURE_CLASS));
    assert.ok(hasClass(getById(notes, 'many-figure'), FIGURE_CLASS));
    assert.ok(hasClass(getById(notes, 'many-figure'), FLOW_CLASS));
    assert.ok(hasClass(getById(notes, 'nested-figure-flow'), FLOW_CLASS));
    assert.ok(hasClass(getById(notes, 'figure-many-link'), LINK_CLASS));
    assert.ok(!hasClass(getById(notes, 'caption-icon'), MEDIA_CLASS));
    assert.strictEqual(
      getById(notes, 'timestamp').getAttribute('data-sec'),
      '65'
    );
    assert.strictEqual(
      getById(notes, 'figure-caption').textContent.replace(/\s+/g, ' ').trim(),
      'Caption 1:05'
    );

    [
      'no210-root-a',
      'no210-root-b',
      'no210-root-figure-image',
      'wrapped-root-image',
    ].forEach(id => assertReaderMedia(notes, id));
    assert.ok(
      !hasClass(notes, FLOW_CLASS),
      'mixed reader roots must not turn all shownotes into a media flow'
    );
    assert.ok(hasClass(getById(notes, 'no210-root-link'), LINK_CLASS));
    assert.ok(hasClass(getById(notes, 'no210-root-figure'), FIGURE_CLASS));
    assert.ok(hasClass(getById(notes, 'wrapped-root'), FLOW_CLASS));
    assert.ok(hasClass(getById(notes, 'wrapped-root-link'), LINK_CLASS));
    assert.strictEqual(
      getById(notes, 'no210-root-b').getAttribute('draggable'),
      'true'
    );
    assert.ok(
      !hasClass(getById(notes, 'no210-inline-image'), MEDIA_CLASS),
      'inline prose images must remain inline even beside independent media'
    );

    const badImage = getById(notes, 'bad-image');
    assert.ok(!hasClass(badImage, MEDIA_CLASS));
    assert.ok(!hasClass(getById(notes, 'bad-wrap'), FLOW_CLASS));

    process.stdout.write('shownotes reader smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
