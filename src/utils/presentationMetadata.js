function text(value) {
  return value == null ? '' : String(value).trim();
}

function artistRoute(id) {
  const value = text(id);
  return value ? '/artist/' + encodeURIComponent(value) : '';
}

function year(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : String(date.getFullYear());
}

function playlistInfo(item) {
  const creator = text(item && item.creator && item.creator.nickname);
  const countValue = Number(item && item.trackCount);
  const count =
    Number.isInteger(countValue) && countValue >= 0
      ? String(countValue) + ' \u9996'
      : '';
  return [creator, count].filter(Boolean).join(' \u00b7 ');
}

// Keep remote metadata structured until Vue renders it with text interpolation.
// No caller should build HTML from these fields.
export function getCoverRowSubText(item, kind) {
  const row = item || {};
  if (kind === 'copywriter') return { text: text(row.copywriter), to: '' };
  if (kind === 'description') return { text: text(row.description), to: '' };
  if (kind === 'updateFrequency') {
    return { text: text(row.updateFrequency), to: '' };
  }
  if (kind === 'creator') {
    const creator = text(row.creator && row.creator.nickname);
    return { text: creator ? 'by ' + creator : '', to: '' };
  }
  if (kind === 'releaseYear') return { text: year(row.publishTime), to: '' };
  if (kind === 'artist') {
    const artist =
      row.artist || (Array.isArray(row.artists) ? row.artists[0] : null) || {};
    return {
      text: text(artist.name),
      to: artistRoute(artist.id),
    };
  }
  if (kind === 'albumType+releaseYear') {
    let albumType = row.type;
    if (row.type === 'EP/Single') albumType = row.size === 1 ? 'Single' : 'EP';
    else if (row.type === 'Single') albumType = 'Single';
    else if (row.type === '\u4e13\u8f91') albumType = 'Album';
    return {
      text: [text(albumType), year(row.publishTime)]
        .filter(Boolean)
        .join(' \u00b7 '),
      to: '',
    };
  }
  if (kind === 'appleMusic') return { text: 'by Apple Music', to: '' };
  if (kind === 'title') return { text: playlistInfo(row), to: '' };
  return { text: '', to: '' };
}

export function getMvSubtitle(mv, kind) {
  const row = mv || {};
  if (kind === 'publishTime') return { text: text(row.publishTime), to: '' };
  const creator = Array.isArray(row.creator) ? row.creator[0] || {} : {};
  const name = text(row.artistName || creator.userName);
  return {
    text: name,
    to: artistRoute(row.artistId || creator.userId),
  };
}
