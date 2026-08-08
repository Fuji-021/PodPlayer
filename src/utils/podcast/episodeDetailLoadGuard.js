export function createEpisodeDetailLoadGuard() {
  let generation = 0;
  let active = true;

  function begin(snapshot) {
    generation += 1;
    active = true;
    return {
      generation,
      episodeId: snapshot && snapshot.episodeId,
      feedUrl: snapshot && snapshot.feedUrl,
    };
  }

  function invalidate() {
    generation += 1;
    active = false;
  }

  function isCurrent(request, snapshot) {
    return !!(
      active &&
      request &&
      request.generation === generation &&
      snapshot &&
      request.episodeId === snapshot.episodeId &&
      request.feedUrl === snapshot.feedUrl
    );
  }

  return { begin, invalidate, isCurrent };
}
