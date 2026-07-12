const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const { DOMParser } = require('@xmldom/xmldom');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-rss-parser-smoke-')
);

function installDomParser() {
  const documentElement = new DOMParser().parseFromString(
    '<rss />',
    'application/xml'
  ).documentElement;
  const elementProto = Object.getPrototypeOf(documentElement);
  if (!Object.getOwnPropertyDescriptor(elementProto, 'children')) {
    Object.defineProperty(elementProto, 'children', {
      configurable: true,
      get() {
        return Array.prototype.filter.call(
          this.childNodes || [],
          node => node.nodeType === 1
        );
      },
    });
  }
  global.DOMParser = DOMParser;
}

async function loadParser() {
  const output = path.join(tempDir, 'rss-parser.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/podcast/rssParser.js')],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  return require(output);
}

function parse(parser, xml, feedUrl) {
  return parser.parseRss(
    xml,
    feedUrl || 'https://feed.example.test/show/feed.xml'
  );
}

async function main() {
  const originalDOMParser = global.DOMParser;
  try {
    installDomParser();
    const parser = await loadParser();

    const standard = parse(
      parser,
      `<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <title>Channel</title>
        <image>
          <url>https://cdn.example.test/channel.jpg</url>
          <title>Channel image title must not join the URL</title>
          <link>https://example.test/channel-link</link>
        </image>
        <item>
          <guid>episode-standard</guid><title>Standard episode</title>
          <enclosure url="https://audio.example.test/standard.mp3" type="audio/mpeg" />
        </item>
      </channel></rss>`
    );
    assert.strictEqual(
      standard.podcast.coverUrl,
      'https://cdn.example.test/channel.jpg'
    );
    assert.strictEqual(
      standard.episodes[0].coverUrl,
      'https://cdn.example.test/channel.jpg'
    );
    assert.ok(!standard.podcast.coverUrl.includes('Channel image title'));

    const emptyFirstImage = parse(
      parser,
      `<?xml version="1.0"?>
      <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
        <title>Fallback image</title>
        <image href="" />
        <itunes:image href="https://cdn.example.test/itunes.jpg" />
        <item><guid>episode-empty-image</guid><title>Episode</title>
          <enclosure url="https://audio.example.test/empty.mp3" />
        </item>
      </channel></rss>`
    );
    assert.strictEqual(
      emptyFirstImage.podcast.coverUrl,
      'https://cdn.example.test/itunes.jpg'
    );

    const relativeChannelImage = parse(
      parser,
      `<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <title>Relative image</title>
        <image><url>/covers/channel.jpg</url></image>
        <item><guid>episode-relative</guid><title>Episode</title>
          <enclosure url="https://audio.example.test/relative.mp3" />
        </item>
      </channel></rss>`,
      'https://feed.example.test/path/feed.xml'
    );
    assert.strictEqual(
      relativeChannelImage.podcast.coverUrl,
      'https://feed.example.test/covers/channel.jpg'
    );

    const episodeOwnImage = parse(
      parser,
      `<?xml version="1.0"?>
      <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
        <title>Episode image</title>
        <itunes:image href="https://cdn.example.test/channel-fallback.jpg" />
        <item>
          <guid>episode-own-image</guid><title>Episode</title>
          <itunes:image href="https://cdn.example.test/episode.jpg" />
          <enclosure url="https://audio.example.test/episode.mp3" />
        </item>
      </channel></rss>`
    );
    assert.strictEqual(
      episodeOwnImage.episodes[0].coverUrl,
      'https://cdn.example.test/episode.jpg'
    );

    process.stdout.write('rss parser smoke: PASS\n');
  } finally {
    if (originalDOMParser === undefined) delete global.DOMParser;
    else global.DOMParser = originalDOMParser;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
